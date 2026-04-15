import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { execa } from 'execa';
import { LLMClient } from '../llm/client.js';
import { ToolRegistry } from '../tools/registry.js';
import { GitManager } from '../git/manager.js';
import { StateMachine } from '../state/machine.js';
import { PlannerAgent } from '../agents/planner.js';
import { GeneratorAgent } from '../agents/generator.js';
import { EvaluatorAgent } from '../agents/evaluator.js';
import { DualLogger, Logger } from '../logger/index.js';
import { ExceptionHandler, ExceptionLevel } from '../exception/handler.js';
import { IsolationMonitor } from '../isolation/monitor.js';
import { ArtifactValidator } from '../artifacts/validator.js';
import { normalizedIncludes } from '../artifacts/text-normalizer.js';
import {
  EVALUATION_DIMENSIONS,
  FINAL_ACCEPTANCE_REQUIRED_SECTIONS,
  DELIVERY_README_REQUIRED_SECTIONS,
  PROJECT_SUMMARY_REQUIRED_SECTIONS,
  dimensionAlternation,
} from '../artifacts/validation-registry.js';
import { SprintNegotiator } from './negotiation.js';
import { PreEvaluator } from './pre-evaluation.js';
import { FeedbackChannel } from './feedback.js';
import { MetricsCollector } from './metrics.js';
import { CheckpointManager, type Checkpoint } from './checkpoint.js';
import { RollbackManager, RollbackLevel } from './rollback.js';
import { ManualIntervention } from './manual-intervention.js';
import { getAdaptiveThresholds, parseEffortScore } from './adaptive-thresholds.js';
import type { HarnessConfig } from '../config.js';
import type { AdaptiveThresholds } from './adaptive-thresholds.js';
import { HarnessState } from '../types.js';

export class Harness {
  private config: HarnessConfig;
  private client: LLMClient;
  private stateMachine: StateMachine;
  private git: GitManager;

  // Agents — initialized in initInfrastructure()
  private planner!: PlannerAgent;
  private generator!: GeneratorAgent;
  private evaluator!: EvaluatorAgent;

  // Infrastructure
  private dualLogger!: DualLogger;
  private metaLogger!: Logger;
  private projectLogger!: Logger;
  private exceptionHandler!: ExceptionHandler;
  private isolationMonitor!: IsolationMonitor;
  private artifactValidator!: ArtifactValidator;
  private negotiator!: SprintNegotiator;
  private preEvaluator!: PreEvaluator;
  private feedbackChannel!: FeedbackChannel;
  private metrics!: MetricsCollector;
  private checkpointManager!: CheckpointManager;
  private rollbackManager!: RollbackManager;
  private manualIntervention!: ManualIntervention;
  private toolRegistry!: ToolRegistry;

  private targetDir: string;
  private metaDir: string;

  constructor(config: HarnessConfig) {
    this.config = config;
    this.client = new LLMClient(config.llm);
    this.targetDir = config.paths.targetProject;
    this.metaDir = resolve(config.paths.metaLogs, '..');

    // Ensure directories
    if (!existsSync(this.targetDir)) mkdirSync(this.targetDir, { recursive: true });
    if (!existsSync(config.paths.metaLogs)) mkdirSync(config.paths.metaLogs, { recursive: true });

    const projectLogDir = resolve(this.targetDir, 'project_logs');
    if (!existsSync(projectLogDir)) mkdirSync(projectLogDir, { recursive: true });

    // State machine
    this.stateMachine = new StateMachine(this.metaDir, this.targetDir);
    this.git = new GitManager(this.targetDir);

    // Agents are declared with ! (definite assignment assertion) above.
    // They are fully initialized in initInfrastructure() before any use.
  }

  private initInfrastructure(): void {
    // Dual logging
    this.dualLogger = new DualLogger(this.config.paths.metaLogs, resolve(this.targetDir, 'project_logs'));
    this.metaLogger = this.dualLogger.meta('harness');
    this.projectLogger = this.dualLogger.project('harness');

    // Exception handler
    this.exceptionHandler = new ExceptionHandler(this.metaLogger.child('exception'), {
      maxRetriesP2: this.config.thresholds.maxSprintIterations,
      maxRollbacksP1: this.config.thresholds.maxRollbacks,
    });

    // Isolation monitor
    this.isolationMonitor = new IsolationMonitor(this.metaDir, this.targetDir, this.metaLogger.child('isolation'));

    // Inject isolation monitor into GitManager
    this.git.setIsolationMonitor(this.isolationMonitor);

    // Inject isolation monitor into tool registry
    const toolRegistry = ToolRegistry.createDefault(this.targetDir);
    toolRegistry.setIsolationMonitor(this.isolationMonitor);
    this.toolRegistry = toolRegistry;

    // Recreate agents with isolated tools
    this.planner = new PlannerAgent(this.client, toolRegistry);
    this.generator = new GeneratorAgent(this.client, toolRegistry, this.targetDir);
    this.evaluator = new EvaluatorAgent(this.client, toolRegistry);

    // Artifact validator
    this.artifactValidator = new ArtifactValidator(this.projectLogger.child('validator'));

    // Negotiation
    this.negotiator = new SprintNegotiator(
      this.generator,
      this.evaluator,
      this.projectLogger.child('negotiation'),
      this.config.thresholds.maxNegotiationRounds,
    );

    // Pre-evaluation
    this.preEvaluator = new PreEvaluator(this.targetDir, this.projectLogger.child('pre-eval'), this.artifactValidator);

    // Feedback channel
    this.feedbackChannel = new FeedbackChannel(this.targetDir, this.projectLogger.child('feedback'));

    // Metrics
    this.metrics = new MetricsCollector(this.metaLogger.child('metrics'));

    // Checkpoint
    this.checkpointManager = new CheckpointManager(this.metaDir, this.metaLogger.child('checkpoint'));

    // Rollback
    this.rollbackManager = new RollbackManager(this.git, this.targetDir, this.projectLogger.child('rollback'));

    // Manual intervention
    this.manualIntervention = new ManualIntervention(this.metaDir, this.metaLogger.child('manual'), this.targetDir);

    this.metaLogger.info('Infrastructure initialized');
  }

  // ============ Main Entry ============

  async run(): Promise<void> {
    this.initInfrastructure();
    this.log('Harness 元程序启动');

    // M-01: Check for resume from checkpoint (断点续跑)
    const latestCheckpoint = this.checkpointManager.getLatest();
    const resumeFrom = latestCheckpoint?.state;
    if (resumeFrom && resumeFrom !== HarnessState.META_INIT && resumeFrom !== HarnessState.FINISHED) {
      this.restoreCheckpointState(latestCheckpoint);
      this.log(`从检查点恢复, 跳过已完成阶段: ${resumeFrom}`);
      this.metaLogger.info('Resuming from checkpoint', { checkpoint: latestCheckpoint.id, state: resumeFrom });
    }

    try {
      // Phase: META_INIT (must succeed before we can lock meta directory)
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.META_INIT)) {
        await this.executePhaseWithRetry(async () => {
          this.metrics.startPhase('META_INIT');
          const isolation = this.isolationMonitor.verifyIsolation();
          if (!isolation.valid) {
            throw new Error(`Isolation verification failed: ${isolation.issues.join('; ')}`);
          }
          this.metrics.endPhase('META_INIT');
          this.saveCheckpoint(HarnessState.META_INIT);
        }, 'META_INIT', this.config.thresholds.maxRetries);
      } else {
        this.log('跳过 META_INIT (从检查点恢复)');
      }

      // S-05: Lock meta-program directory to read-only for build phase
      this.isolationMonitor.lockMetaDirectory();
      this.metaLogger.info('Meta-program directory locked to read-only for build phase');

      // Step 1: PROJECT_INIT
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.PROJECT_INIT)) {
        await this.executePhaseWithRetry(() => this.projectInit(), 'PROJECT_INIT', this.config.thresholds.maxRetries);
      } else {
        this.log('跳过 PROJECT_INIT (从检查点恢复)');
      }

      // Step 2: REQUIREMENT_PARSE
      let standardReq = '';
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.REQUIREMENT_PARSE)) {
        standardReq = await this.executePhaseWithRetry(
          () => this.requirementParse(),
          'REQUIREMENT_PARSE',
          this.config.thresholds.maxRetries,
        );
      } else {
        this.log('跳过 REQUIREMENT_PARSE (从检查点恢复)');
        const standardReqPath = resolve(this.targetDir, 'standard_requirement.md');
        if (existsSync(standardReqPath)) {
          standardReq = readFileSync(standardReqPath, 'utf-8');
        }
      }

      // Step 3: PLANNING
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.PLANNING)) {
        await this.executePhaseWithRetry(() => this.planning(standardReq), 'PLANNING', this.config.thresholds.maxRetries);
      } else {
        this.log('跳过 PLANNING (从检查点恢复)');
      }

      // Step 4: Sprint loop
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.SPRINT_DISPATCH)) {
        await this.executePhaseWithRetry(() => this.sprintLoop(), 'SPRINT_LOOP', this.config.thresholds.maxRetries);
      } else {
        this.log('跳过 SPRINT_LOOP (从检查点恢复)');
      }

      // Step 5: FINAL_ACCEPTANCE
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.FINAL_ACCEPTANCE)) {
        await this.executePhaseWithRetry(() => this.finalAcceptance(), 'FINAL_ACCEPTANCE', this.config.thresholds.maxRetries);
      } else {
        this.log('跳过 FINAL_ACCEPTANCE (从检查点恢复)');
      }

      // Step 6: RELEASE
      if (!this.shouldSkipPhase(resumeFrom, HarnessState.RELEASE)) {
        await this.executePhaseWithRetry(() => this.release(), 'RELEASE', this.config.thresholds.maxRetries);
      } else {
        this.log('跳过 RELEASE (从检查点恢复)');
      }

      this.log('Harness 元程序执行完成!');
      this.metaLogger.info('Harness completed successfully');
    } finally {
      // Always unlock meta directory and record final metrics, even on failure
      this.isolationMonitor.unlockMetaDirectory();
      this.metaLogger.info('Meta-program directory unlocked');
      this.metrics.finalize();
    }
  }

  /**
   * S-02: Execute a phase with retry logic for recoverable exceptions.
   * When handleException returns 'retry' or 'rollback', the phase is retried
   * up to maxRetries times. 'skip' continues to the caller (phase considered done).
   * 'abort' requests manual intervention and re-throws immediately.
   */
  private async executePhaseWithRetry<T>(
    phase: () => Promise<T>,
    phaseName: string,
    maxRetries: number,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await phase();
      } catch (err) {
        const currentState = this.stateMachine.getMetaState().currentState;

        if (attempt < maxRetries) {
          this.stateMachine.transitionMeta(HarnessState.EXCEPTION_HANDLE);
          const result = await this.exceptionHandler.handle(err, currentState, phaseName);
          this.metrics.recordException(result.record.level, result.healed, result.upgraded);

          this.stateMachine.incrementError();
          this.stateMachine.getMetaState().metrics.exceptionsHandled++;

          if (result.action === 'skip') {
            // Minor exception, consider phase done but re-throw to signal incomplete result
            this.metaLogger.info('Minor exception during phase, continuing', { phaseName });
            throw err;
          }

          if (result.action === 'abort') {
            // Fatal exception, request manual intervention and re-throw
            await this.manualIntervention.requestIntervention(
              result.record.message,
              currentState,
              result.record.message,
              JSON.stringify(this.stateMachine.getMetaState()),
            );
            throw err;
          }

          // For 'retry': retry the phase
          if (result.action === 'retry') {
            this.metaLogger.warn(`Retrying phase ${phaseName} after exception (attempt ${attempt + 1}/${maxRetries})`);
            continue;
          }

          // For 'rollback': execute rollback then retry the phase
          if (result.action === 'rollback') {
            const rollbackLevel = result.record.level === ExceptionLevel.P0
              ? RollbackLevel.CATASTROPHIC
              : result.record.level === ExceptionLevel.P1
                ? RollbackLevel.SPRINT
                : RollbackLevel.SPRINT;
            this.metaLogger.warn(`Rolling back before retry of phase ${phaseName} (attempt ${attempt + 1}/${maxRetries})`);
            const rollbackRecord = await this.rollbackManager.execute(
              rollbackLevel,
              result.record.message,
              this.stateMachine.getProjectState().currentSprintId || undefined,
            );
            if (!rollbackRecord.success) {
              await this.manualIntervention.requestIntervention(
                `Rollback failed before retry of ${phaseName}: ${rollbackRecord.auditLog}`,
                currentState,
                result.record.message,
                JSON.stringify(this.stateMachine.getMetaState()),
              );
              throw err;
            }
            continue;
          }
        }

        // Exhausted all retries - run final exception handling via the original method
        await this.handleException(err, currentState);
        throw err;
      }
    }

    // Should not reach here, but TypeScript needs it
    throw new Error(`Phase ${phaseName} failed after ${maxRetries} retries`);
  }

  // ============ Exception Handling Integration ============

  private async handleException(error: unknown, phase: HarnessState): Promise<void> {
    this.stateMachine.transitionMeta(HarnessState.EXCEPTION_HANDLE);

    const result = await this.exceptionHandler.handle(error, phase, 'harness');
    this.metrics.recordException(result.record.level, result.healed, result.upgraded);

    this.stateMachine.incrementError();
    this.stateMachine.getMetaState().metrics.exceptionsHandled++;

    switch (result.action) {
      case 'retry':
        this.metaLogger.warn('Exception self-healed, will retry');
        // Retries are now handled by executePhaseWithRetry; this re-throws for exhausted cases
        throw error;

      case 'rollback':
        this.metaLogger.warn('Triggering rollback');
        const rollbackLevel = result.record.level === ExceptionLevel.P0
          ? RollbackLevel.CATASTROPHIC
          : result.record.level === ExceptionLevel.P1
            ? RollbackLevel.SPRINT
            : RollbackLevel.SPRINT;
        const rollbackRecord = await this.rollbackManager.execute(
          rollbackLevel,
          result.record.message,
          this.stateMachine.getProjectState().currentSprintId || undefined,
        );
        if (!rollbackRecord.success) {
          await this.manualIntervention.requestIntervention(
            `Rollback failed: ${rollbackRecord.auditLog}`,
            phase,
            result.record.message,
            JSON.stringify(this.stateMachine.getMetaState()),
          );
        }
        throw error;

      case 'abort':
        await this.manualIntervention.requestIntervention(
          result.record.message,
          phase,
          result.record.message,
          JSON.stringify(this.stateMachine.getMetaState()),
        );
        throw error;

      case 'skip':
        this.metaLogger.info('Minor exception, continuing');
        break;
    }
  }

  // ============ Step 1: PROJECT_INIT ============

  private async projectInit(): Promise<void> {
    this.metrics.startPhase('PROJECT_INIT');
    this.log('>>> PROJECT_INIT - 初始化目标项目');
    this.stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    this.stateMachine.transitionProject(HarnessState.PROJECT_INIT);

    if (!existsSync(resolve(this.targetDir, '.git'))) {
      await this.git.initTargetRepo();
      await this.git.ensureBranch('dev');

      // Copy idea.md and set read-only
      const ideaContent = readFileSync(this.config.paths.ideaFile, 'utf-8');
      const ideaPath = resolve(this.targetDir, 'idea.md');
      writeFileSync(ideaPath, ideaContent, 'utf-8');
      chmodSync(ideaPath, 0o444); // Read-only protection
      await this.git.addAll();
      await this.git.commit('docs', 'project', 'copy original idea.md to target project', {
        allowProtectedBranchCommit: true,
      });

      this.log('目标项目初始化完成');
    } else {
      await this.git.ensureBranch('dev');
      const repair = this.reconcileExistingTargetProjectInitialization();

      if (repair.changed) {
        await this.git.addAll();
        await this.git.commit('chore', 'project', 'backfill target project initialization contract', {
          allowProtectedBranchCommit: true,
        });
        this.log(`目标项目已存在，已补齐初始化契约: ${repair.repaired.join(', ')}`);
      } else {
        this.log('目标项目已存在，初始化契约完整，跳过初始化');
      }
    }

    // Verify isolation after init
    this.isolationMonitor.verifyIsolation();
    this.metrics.endPhase('PROJECT_INIT');
    this.metrics.updateIsolationMetrics(this.isolationMonitor);
    this.assertPostCondition(HarnessState.PROJECT_INIT);
    this.saveCheckpoint(HarnessState.PROJECT_INIT);
    this.stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    this.stateMachine.transitionProject(HarnessState.REQUIREMENT_PARSE);
  }

  private reconcileExistingTargetProjectInitialization(): { changed: boolean; repaired: string[] } {
    let changed = false;
    const repaired: string[] = [];
    const requiredDirs = ['docs/plan', 'docs/sprint', 'docs/report', 'src', 'test'];

    for (const dir of requiredDirs) {
      const dirPath = resolve(this.targetDir, dir);
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
        changed = true;
        repaired.push(dir);
      }
    }

    const gitignorePath = resolve(this.targetDir, '.gitignore');
    const requiredIgnoreEntries = [
      'node_modules/',
      '__pycache__/',
      '*.pyc',
      'venv/',
      '.env',
      '.DS_Store',
      'project_logs/',
      'project_state.json',
      'dist/',
      '*.tmp',
      '*.temp',
    ];
    const existingIgnoreEntries = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      : [];
    const mergedIgnoreEntries = [...existingIgnoreEntries];

    for (const entry of requiredIgnoreEntries) {
      if (!mergedIgnoreEntries.includes(entry)) {
        mergedIgnoreEntries.push(entry);
      }
    }

    if (!existsSync(gitignorePath) || mergedIgnoreEntries.length !== existingIgnoreEntries.length) {
      writeFileSync(gitignorePath, `${mergedIgnoreEntries.join('\n')}\n`, 'utf-8');
      changed = true;
      repaired.push('.gitignore');
    }

    const ideaPath = resolve(this.targetDir, 'idea.md');
    const ideaContent = readFileSync(this.config.paths.ideaFile, 'utf-8');
    if (!existsSync(ideaPath) || readFileSync(ideaPath, 'utf-8') !== ideaContent) {
      writeFileSync(ideaPath, ideaContent, 'utf-8');
      changed = true;
      repaired.push('idea.md');
    }

    const currentMode = statSync(ideaPath).mode & 0o777;
    if ((currentMode & 0o222) !== 0) {
      repaired.push('idea.md(read-only)');
    }
    chmodSync(ideaPath, 0o444);

    return { changed, repaired };
  }

  // ============ Step 2: REQUIREMENT_PARSE ============

  private async requirementParse(): Promise<string> {
    this.metrics.startPhase('REQUIREMENT_PARSE');
    this.log('>>> REQUIREMENT_PARSE - 解析需求文档');
    this.stateMachine.transitionProject(HarnessState.REQUIREMENT_PARSE);

    const standardReqPath = resolve(this.targetDir, 'standard_requirement.md');

    if (existsSync(standardReqPath)) {
      const existingValidation = this.artifactValidator.validateFile(standardReqPath);
      if (!existingValidation.valid) {
        throw new Error(`Standard requirement validation failed: ${existingValidation.errors.join('; ')}`);
      }
      this.log('标准化需求已存在，跳过');
      this.metrics.endPhase('REQUIREMENT_PARSE');
      this.stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
      this.stateMachine.transitionProject(HarnessState.REQUIREMENT_PARSE);
      this.stateMachine.transitionMeta(HarnessState.PLANNING);
      this.stateMachine.transitionProject(HarnessState.PLANNING);
      return readFileSync(standardReqPath, 'utf-8');
    }

    const ideaContent = readFileSync(this.config.paths.ideaFile, 'utf-8');
    this.log('调用 LLM 解析需求...');

    const standardReq = await this.client.generateWithSystem(
      `你是需求分析专家。请将用户的原始需求文档转换为标准化的需求文档。
输出 Markdown 格式，包含以下章节：
1. 项目名称与概述
2. 核心功能清单（带功能ID、优先级P0/P1/P2）
3. 技术栈要求
4. 约束条件
5. 不做范围
格式清晰、结构化、无歧义。`,
      `请将以下原始需求转换为标准化需求文档:\n\n${ideaContent}`,
    );

    writeFileSync(standardReqPath, standardReq, 'utf-8');
    await this.git.addAll();
    await this.git.commit('docs', 'project', 'generate standardized requirement document', {
      allowProtectedBranchCommit: true,
    });

    // Validate requirement completeness before allowing the flow to proceed
    const reqValidation = this.artifactValidator.validateFile(standardReqPath);
    if (!reqValidation.valid) {
      throw new Error(`Standard requirement validation failed: ${reqValidation.errors.join('; ')}`);
    }

    this.metrics.endPhase('REQUIREMENT_PARSE');
    this.assertPostCondition(HarnessState.REQUIREMENT_PARSE);
    this.saveCheckpoint(HarnessState.REQUIREMENT_PARSE);
    this.stateMachine.transitionMeta(HarnessState.PLANNING);
    this.stateMachine.transitionProject(HarnessState.PLANNING);
    this.log('需求解析完成');
    return standardReq;
  }

  // ============ Step 3: PLANNING ============

  private async planning(standardReq: string): Promise<void> {
    this.metrics.startPhase('PLANNING');
    this.log('>>> PLANNING - 规划设计');
    this.stateMachine.transitionProject(HarnessState.PLANNING);

    const planDir = resolve(this.targetDir, 'docs/plan');
    const requiredFiles = ['product_spec.md', 'architecture_design.md', 'project_structure.md', 'code_standard.md', 'sprint_plan.md'];
    const allExist = requiredFiles.every(f => existsSync(resolve(planDir, f)));

    if (allExist) {
      // Validate all planning docs
      const validations = this.artifactValidator.validatePlanningDocs(planDir);
      const allValid = validations.every(v => v.valid);
      if (allValid) {
        this.log('设计文档已全部存在且有效，跳过');
        this.metrics.endPhase('PLANNING');
        this.stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
        this.stateMachine.transitionProject(HarnessState.SPRINT_DISPATCH);
        return;
      }
    }

    await this.git.createBranch('feat/architecture-design', 'dev');

    this.log('调用 Planner Agent 生成设计方案...');
    const plannerStart = Date.now();

    await this.planner.plan(standardReq, (text) => {
      process.stdout.write(chalk.gray('.'));
    });
    console.log();
    this.metrics.recordAgentCall('planner', Date.now() - plannerStart);

    // Validate generated docs with retry
    let finalPlanningErrors: string[] = [];
    const maxPlanRetries = 3;
    for (let planAttempt = 1; planAttempt <= maxPlanRetries; planAttempt++) {
      const validations = this.artifactValidator.validatePlanningDocs(planDir);
      const invalidDocs = validations.filter(v => !v.valid);

      if (invalidDocs.length === 0) {
        finalPlanningErrors = [];
        break;
      }

      finalPlanningErrors = invalidDocs.flatMap(v =>
        v.errors.map(error => `${v.file}: ${error}`),
      );

      if (planAttempt < maxPlanRetries) {
        this.projectLogger.warn(`Planning docs validation failed (attempt ${planAttempt}/${maxPlanRetries}), regenerating...`, {
          invalidDocs: invalidDocs.map(v => ({ file: v.file, errors: v.errors })),
        });
        await this.planner.plan(standardReq, (text) => {
          process.stdout.write(chalk.gray('.'));
        });
        console.log();
      } else {
        this.projectLogger.error('Planning docs validation failed after all retries', {
          invalidDocs: invalidDocs.map(v => ({ file: v.file, errors: v.errors })),
        });
      }
    }

    if (finalPlanningErrors.length > 0) {
      throw new Error(`Planning docs validation failed after retries: ${finalPlanningErrors.join('; ')}`);
    }

    this.assertPostCondition(HarnessState.PLANNING);

    await this.git.addAll();
    await this.git.commit('docs', 'planner', 'generate complete design documents (5 files)');
    await this.git.mergeBranch('feat/architecture-design', 'dev');
    await this.git.createTag('v0.1.0-plan-complete');
    await this.git.deleteBranch('feat/architecture-design');

    this.metrics.endPhase('PLANNING');
    this.saveCheckpoint(HarnessState.PLANNING);
    this.stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
    this.stateMachine.transitionProject(HarnessState.SPRINT_DISPATCH);
    this.log('规划设计完成');
  }

  // ============ Step 4: Sprint Loop ============

  private async sprintLoop(): Promise<void> {
    this.log('>>> SPRINT_DISPATCH - Sprint 循环');
    this.stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
    this.stateMachine.transitionProject(HarnessState.SPRINT_DISPATCH);
    this.metrics.startPhase('SPRINT_DISPATCH');

    const sprintPlanPath = resolve(this.targetDir, 'docs/plan/sprint_plan.md');
    if (!existsSync(sprintPlanPath)) {
      throw new Error('Sprint plan not found. Planning phase may have failed.');
    }

    const sprintPlan = readFileSync(sprintPlanPath, 'utf-8');
    const sprintIds = this.parseSprintIds(sprintPlan);
    const orderedSprintIds = this.buildSprintExecutionOrder(sprintIds);
    this.log(`发现 ${sprintIds.length} 个 Sprint: ${orderedSprintIds.join(', ')}`);

    // D-05/Q-08: Register each sprint into the state machine
    for (let idx = 0; idx < sprintIds.length; idx++) {
      const sprintId = sprintIds[idx];
      const existing = this.stateMachine.getSprint(sprintId);
      if (!existing) {
        this.stateMachine.addSprint({
          id: sprintId,
          name: sprintId,
          priority: idx + 1,
          goals: [],
          deliverables: [],
          dependencies: [],
          status: 'pending',
        });
      }
    }

    const architectureDesign = this.readFile(resolve(this.targetDir, 'docs/plan/architecture_design.md'));
    const codeStandard = this.readFile(resolve(this.targetDir, 'docs/plan/code_standard.md'));
    const productSpec = this.readFile(resolve(this.targetDir, 'docs/plan/product_spec.md'));

    for (const sprintId of orderedSprintIds) {
      // P3-08: Check sprint dependencies before execution
      const sprintInfo = this.stateMachine.getSprint(sprintId);
      if (sprintInfo && !this.stateMachine.areDependenciesMet(sprintInfo)) {
        this.log(`${sprintId}: 依赖未满足, 跳过`);
        this.projectLogger.warn('Sprint dependencies not met, skipping', { sprintId });
        continue;
      }

      this.metrics.startSprint(sprintId);

      // Update state machine with current sprint
      this.stateMachine.setCurrentSprint(sprintId);
      this.stateMachine.updateSprint(sprintId, { status: 'in_progress' });

      // Get adaptive thresholds based on effort score
      const sprintSection = this.extractSprintSection(sprintPlan, sprintId);
      const effortScore = parseEffortScore(sprintSection);
      const adaptiveThresholds = getAdaptiveThresholds(effortScore, this.metaLogger);

      // S-02 fix: Retry sprint after rollback — rollback count determines retries
      const maxSprintAttempts = this.config.thresholds.maxRollbacks;
      for (let attempt = 1; attempt <= maxSprintAttempts; attempt++) {
        const sprintResult = await this.executeSprint(
          sprintId, sprintPlan, sprintSection,
          architectureDesign, codeStandard, productSpec, adaptiveThresholds, attempt,
        );
        if (sprintResult === 'passed') break;
        if (sprintResult === 'failed' && attempt < maxSprintAttempts) {
          this.log(`${sprintId}: Sprint 回退后重新开始 (尝试 ${attempt + 1}/${maxSprintAttempts})`);
          this.projectLogger.warn('Retrying sprint after rollback', { sprintId, attempt });
          this.stateMachine.updateSprint(sprintId, { status: 'in_progress' });
        } else if (sprintResult === 'failed') {
          this.log(`${sprintId}: Sprint 达到最大回退重试次数, 放弃`);
          this.projectLogger.error('Sprint failed after max rollback retries', { sprintId, maxAttempts: maxSprintAttempts });
        }
      }
    }

    this.log('所有 Sprint 执行完成!');
  }

  private async executeSprint(
    sprintId: string,
    sprintPlan: string,
    sprintSection: string,
    architectureDesign: string,
    codeStandard: string,
    productSpec: string,
    thresholds: AdaptiveThresholds,
    attempt: number = 1,
  ): Promise<'passed' | 'failed'> {
    this.log(`\n${'='.repeat(60)}`);
    this.log(`>>> Sprint: ${sprintId} (effort: ${parseEffortScore(sprintSection)}/10)`);
    this.log('='.repeat(60));

    // Recovery: if meta or project state is stuck in EXCEPTION_HANDLE/MANUAL_INTERVENTION,
    // force-reset to SPRINT_DISPATCH before starting sprint execution.
    // This prevents invalid state transitions when retrying after a rollback failure.
    this.resetToSprintDispatchIfNeeded();

    // Check if we can resume from a sprint sub-state
    const latestCheckpoint = this.checkpointManager.getLatest();
    const resumeSubState = latestCheckpoint?.currentSprintId === sprintId
      ? latestCheckpoint.sprintSubState : undefined;
    const resumeIteration = latestCheckpoint?.currentSprintId === sprintId
      ? latestCheckpoint.sprintIteration : undefined;

    const subStateOrder: HarnessState[] = [
      HarnessState.SPRINT_NEGOTIATION,
      HarnessState.DEV,
      HarnessState.PRE_EVALUATION,
      HarnessState.EVALUATION,
      HarnessState.SPRINT_MERGE,
    ];

    const shouldSkipSubState = (target: HarnessState): boolean => {
      if (!resumeSubState) return false;
      const resumeIdx = subStateOrder.indexOf(resumeSubState);
      const targetIdx = subStateOrder.indexOf(target);
      return resumeIdx >= 0 && targetIdx >= 0 && targetIdx < resumeIdx;
    };

    this.metrics.startPhase(`SPRINT_${sprintId}`);
    this.stateMachine.transitionMeta(HarnessState.SPRINT_NEGOTIATION);
    this.stateMachine.transitionProject(HarnessState.SPRINT_NEGOTIATION);
    this.saveCheckpoint(HarnessState.SPRINT_NEGOTIATION);

    // Create sprint branch
    await this.git.checkout('dev');
    const branchName = `sprint/${sprintId}`;
    if (await this.git.branchExists(branchName)) {
      await this.git.checkout(branchName);
    } else {
      await this.git.createBranch(branchName, 'dev');
    }

    // === Negotiation ===
    const contractPath = resolve(this.targetDir, `docs/sprint/sprint_contract_${sprintId}.md`);
    let contract = '';

    if (shouldSkipSubState(HarnessState.SPRINT_NEGOTIATION)) {
      this.log(`跳过 SPRINT_NEGOTIATION (从检查点恢复)`);
      // Read existing contract from disk
      if (!existsSync(contractPath)) {
        this.projectLogger.warn('Resume: contract file missing despite checkpoint, re-negotiating', { sprintId, contractPath });
        // Fall through to re-negotiate instead of crashing
      } else {
        const contractValidation = this.artifactValidator.validateSprintContract(contractPath);
        if (!contractValidation.valid) {
          this.projectLogger.warn('Resume: existing contract invalid, re-negotiating', { sprintId, errors: contractValidation.errors });
          // Fall through to re-negotiate
        } else {
          contract = this.readFile(contractPath);
        }
      }

      // If contract was recovered successfully, skip negotiation
      if (contract) {
        // contract already loaded above
      } else if (!existsSync(contractPath) || contract === '') {
        // Re-negotiate since contract is missing or invalid
        this.log('重新协商 Sprint 合同 (合同文件缺失或无效)');
        const negotiationResult = await this.negotiator.negotiate(
          { id: sprintId, name: sprintId, priority: 1, goals: [], deliverables: [], dependencies: [], status: 'in_progress' },
          sprintSection,
          productSpec,
          architectureDesign,
          contractPath,
        );
        this.metrics.recordNegotiation(sprintId, negotiationResult.rounds);
        if (!negotiationResult.success) {
          this.projectLogger.error('Sprint contract re-negotiation failed, aborting sprint', { sprintId });
          this.metrics.endPhase(`SPRINT_${sprintId}`);
          return 'failed' as const;
        }
        const contractValidation = this.artifactValidator.validateSprintContract(contractPath);
        if (!contractValidation.valid) {
          throw new Error(`Re-negotiated contract still invalid: ${contractValidation.errors.join('; ')}`);
        }
        contract = this.readFile(contractPath);
        this.saveCheckpoint(HarnessState.SPRINT_NEGOTIATION);
      }
    } else {
      this.log('Sprint 合同协商...');

      const negotiationResult = await this.negotiator.negotiate(
        { id: sprintId, name: sprintId, priority: 1, goals: [], deliverables: [], dependencies: [], status: 'in_progress' },
        sprintSection,
        productSpec,
        architectureDesign,
        contractPath,
      );

      this.metrics.recordNegotiation(sprintId, negotiationResult.rounds);

      if (!negotiationResult.success) {
        this.projectLogger.error('Sprint contract negotiation failed, aborting sprint', { sprintId });
        this.metrics.endPhase(`SPRINT_${sprintId}`);
        return 'failed' as const;
      }

      // Validate contract
      const contractValidation = this.artifactValidator.validateSprintContract(contractPath);
      if (!contractValidation.valid) {
        throw new Error(`Sprint contract validation failed: ${contractValidation.errors.join('; ')}`);
      }

      contract = this.readFile(contractPath);

      await this.git.addAll();
      await this.git.commit('docs', `sprint-${sprintId}`, `sprint contract for ${sprintId} (rounds: ${negotiationResult.rounds})`);
    }

    // === Development + Evaluation Loop ===
    this.stateMachine.transitionMeta(HarnessState.DEV);
    this.stateMachine.transitionProject(HarnessState.DEV);
    const maxIterations = thresholds.maxSprintIterations;
    let sprintPassed = false;

    // Start iteration from checkpoint or 1
    const startIteration = (shouldSkipSubState(HarnessState.DEV) && resumeIteration) ? resumeIteration : 1;
    if (startIteration > 1) {
      this.log(`从检查点恢复, 从迭代 ${startIteration} 继续`);
    }

    for (let iteration = startIteration; iteration <= maxIterations; iteration++) {
      if (iteration > startIteration) {
        this.stateMachine.transitionMeta(HarnessState.DEV);
        this.stateMachine.transitionProject(HarnessState.DEV);
      }
      this.log(`--- ${sprintId}: 迭代 ${iteration}/${maxIterations} ---`);
      this.metrics.recordSprintIteration(sprintId);
      this.saveCheckpoint(HarnessState.DEV, iteration);

      // Development
      const existingSummary = await this.getExistingCodeSummary();

      if (iteration === 1) {
        this.log('调用 Generator 开发...');
        const generatorStart = Date.now();
        await this.generator.develop(sprintId, contract, architectureDesign, codeStandard, existingSummary, (text) => {
          process.stdout.write(chalk.cyan('.'));
        });
        this.metrics.recordAgentCall('generator', Date.now() - generatorStart);
      } else {
        const reviewPath = resolve(this.targetDir, `docs/sprint/review_report_${sprintId}.md`);
        const reviewReport = this.readFile(reviewPath);
        this.log('调用 Generator 修复...');
        await this.generator.fix(reviewReport, contract, iteration, (text) => {
          process.stdout.write(chalk.yellow('.'));
        });
      }
      console.log();

      await this.git.addAll();
      await this.git.commit('feat', `sprint-${sprintId}`, `${iteration === 1 ? 'implement' : 'fix'} code for ${sprintId} (iter ${iteration})`);

      // === Pre-Evaluation ===
      this.stateMachine.transitionMeta(HarnessState.PRE_EVALUATION);
      this.stateMachine.transitionProject(HarnessState.PRE_EVALUATION);
      this.saveCheckpoint(HarnessState.PRE_EVALUATION);
      this.log('预验收检查...');

      const preEvalResult = await this.preEvaluator.runPreEvaluation(
        sprintId, contractPath,
      );

      if (!preEvalResult.passed) {
        this.projectLogger.warn('Pre-evaluation failed', { sprintId, issues: preEvalResult.issues });
        this.log('预验收未通过, 直接修复');
        continue; // Skip formal evaluation, go straight to next iteration
      }

      this.log('预验收通过, 进入正式验收');

      // === Formal Evaluation ===
      this.stateMachine.transitionMeta(HarnessState.EVALUATION);
      this.stateMachine.transitionProject(HarnessState.EVALUATION);
      this.saveCheckpoint(HarnessState.EVALUATION);
      this.log('调用 Evaluator 验收评估...');
      const evaluatorStart = Date.now();

      await this.evaluator.evaluate(contract, architectureDesign, codeStandard, sprintId, (text) => {
        process.stdout.write(chalk.red('.'));
      });
      console.log();
      this.metrics.recordAgentCall('evaluator', Date.now() - evaluatorStart);

      await this.git.addAll();
      await this.git.commit('docs', 'evaluator', `evaluation report for ${sprintId} (iter ${iteration})`, {
        allowProtectedBranchCommit: true,
      });

      // Validate review report
      const reviewPath = resolve(this.targetDir, `docs/sprint/review_report_${sprintId}.md`);
      const reviewValidation = this.artifactValidator.validateReviewReport(reviewPath);
      if (!reviewValidation.valid) {
        this.projectLogger.warn('Review report validation issues', { errors: reviewValidation.errors });
      }

      // Check evaluation result
      const reviewReport = this.readFile(reviewPath);
      const evalPassed = this.checkEvaluationPassed(reviewReport);

      // Check for architecture feedback
      const feedback = this.feedbackChannel.parseFromEvaluationReport(reviewReport, sprintId);
      if (feedback) {
        this.feedbackChannel.submitFeedback(feedback);
        this.projectLogger.warn('Architecture feedback detected', { sprintId });

        // Process architecture feedback through Planner if critical
        if (feedback.requiresArchitectureRevision) {
          this.log('架构反馈需要修订, 调用 Planner 处理...');
          this.stateMachine.transitionMeta(HarnessState.PLANNING);
          const pendingFeedback = this.feedbackChannel.getPendingFeedback();
          const feedbackReports = pendingFeedback
            .map(f => this.readFile(resolve(this.targetDir, `docs/sprint/architecture_feedback_${f.sprintId}.md`)))
            .filter(Boolean)
            .join('\n\n---\n\n');

          if (feedbackReports) {
            await this.planner.plan(
              `【架构反馈修订】以下是Evaluator在验收过程中发现的架构问题，请基于原始需求和以下反馈，修订受影响的设计文档。\n\n${feedbackReports}`,
              (text) => process.stdout.write(chalk.gray('.')),
            );
            console.log();
            await this.git.addAll();
            await this.git.commit('docs', 'planner', 'architecture revision based on evaluator feedback');
          }
          this.feedbackChannel.clearFeedback(pendingFeedback.map(f => f.id));
          this.stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
        }
      }

      if (evalPassed) {
        this.log(`${sprintId}: 验收通过!`);
        sprintPassed = true;
        this.metrics.endSprint(sprintId, true);
        this.exceptionHandler.resetConsecutiveFailures();
        break;
      } else {
        this.log(`${sprintId}: 验收未通过`);
        if (iteration === maxIterations) {
          this.log(`${sprintId}: 达到最大迭代次数, Sprint 失败`);
          this.metrics.endSprint(sprintId, false);

          // Trigger sprint-level rollback
          this.projectLogger.warn('Max iterations reached, triggering sprint rollback', { sprintId });
          const rollbackRecord = await this.rollbackManager.execute(
            RollbackLevel.SPRINT,
            `Max iterations (${maxIterations}) reached`,
            sprintId,
          );
          if (!rollbackRecord.success) {
            await this.manualIntervention.requestIntervention(
              `Sprint ${sprintId} rollback failed`,
              HarnessState.EXCEPTION_HANDLE,
              rollbackRecord.auditLog,
              JSON.stringify(this.stateMachine.getMetaState()),
            );
          }
        }
      }

      this.metrics.recordEvaluationScore(this.extractScore(reviewReport));
      this.stateMachine.incrementIterations();
    }

    // Check if architecture feedback requires escalation
    if (this.feedbackChannel.hasRollbackRequest()) {
      this.projectLogger.fatal('Architecture rollback requested by Evaluator');
      const rollbackRecord = await this.rollbackManager.execute(
        RollbackLevel.ARCHITECTURE,
        'Architecture-level defects detected by Evaluator',
      );
      if (!rollbackRecord.success) {
        await this.manualIntervention.requestIntervention(
          'Architecture rollback failed',
          HarnessState.EXCEPTION_HANDLE,
          rollbackRecord.auditLog,
          JSON.stringify(this.stateMachine.getMetaState()),
        );
      }
    }

    // P2-02: Only merge if sprint passed evaluation
    if (!sprintPassed) {
      this.log(`${sprintId}: Sprint 验收未通过, 跳过合并`);
      // Note: branch is NOT deleted here — rollback caller may need to retry
      this.metrics.endPhase(`SPRINT_${sprintId}`);
      return 'failed' as const;
    }

    // Merge
    this.stateMachine.transitionMeta(HarnessState.SPRINT_MERGE);
    this.stateMachine.transitionProject(HarnessState.SPRINT_MERGE);
    this.saveCheckpoint(HarnessState.SPRINT_MERGE);
    this.log(`合并 ${sprintId} 到 dev...`);
    const mergeOk = await this.git.mergeBranch(branchName, 'dev');
    if (!mergeOk) {
      throw new Error(`合并 ${sprintId} 到 dev 失败, 存在合并冲突`);
    }

    // Q-09: Mark sprint as completed in state machine after merge
    const sprintCompletionTag = this.formatSprintCompletionTag(sprintId);
    const sprintMilestoneTag = this.formatSprintCompletionMilestone(sprintId);
    this.stateMachine.completeSprint(sprintId);
    this.stateMachine.updateSprint(sprintId, { status: 'completed' });
    this.stateMachine.addMilestoneTag(sprintMilestoneTag);

    // Post-merge verification: run compilation and basic tests
    this.log('合并后验证 - 执行编译和基础测试...');
    try {
      const postMergeResult = await this.runPostMergeVerification();
      if (!postMergeResult.passed) {
        this.projectLogger.error('Post-merge verification failed', { sprintId, issues: postMergeResult.issues });
        throw new Error(`合并后验证失败: ${postMergeResult.issues.join('; ')}`);
      }
      this.log('合并后验证通过');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('合并后验证失败')) throw err;
      this.log(`合并后验证异常: ${err instanceof Error ? err.message : String(err)}, 继续后续流程`);
    }

    await this.git.createTag(sprintCompletionTag);
    await this.git.deleteBranch(branchName);

    this.metrics.endPhase(`SPRINT_${sprintId}`);
    this.saveCheckpoint(HarnessState.SPRINT_MERGE);
    this.assertPostCondition(HarnessState.SPRINT_MERGE, { sprintId });
    this.stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
    this.log(`${sprintId}: Sprint 完成!`);
    return 'passed' as const;
  }

  // ============ Step 5: Final Acceptance ============

  private async finalAcceptance(): Promise<void> {
    this.metrics.startPhase('FINAL_ACCEPTANCE');
    this.log('>>> FINAL_ACCEPTANCE - 全量验收');
    this.assertFinalAcceptanceReady();
    this.stateMachine.transitionMeta(HarnessState.FINAL_ACCEPTANCE);
    this.stateMachine.transitionProject(HarnessState.FINAL_ACCEPTANCE);

    const productSpec = this.readFile(resolve(this.targetDir, 'docs/plan/product_spec.md'));
    const summary = `全量验收: 请检查目标项目所有代码是否完整实现了产品规格中的核心功能。
${productSpec}

请使用 glob 查看完整项目结构，使用 file_read 检查核心代码文件，使用 bash 执行编译和测试验证。
将最终验收报告写入 docs/report/final_acceptance_report.md`;

    // Reuse the existing toolRegistry from initInfrastructure instead of creating new one
    const evaluator = new EvaluatorAgent(this.client, this.toolRegistry);
    let fallbackReason: string | undefined;

    try {
      await evaluator.run(summary, {
        systemPromptOverride: `你是最终验收评估专家。对整个项目进行全量验收评估。
检查所有核心功能是否完整实现，代码质量是否达标，系统是否能正常运行。
将验收报告写入 docs/report/final_acceptance_report.md。`,
      });
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
      this.projectLogger.warn('Final acceptance LLM evaluation failed', {
        error: fallbackReason,
      });
    }

    this.validateFinalAcceptanceReportOrThrow(fallbackReason);

    this.assertPostCondition(HarnessState.FINAL_ACCEPTANCE);

    await this.git.addAll();
    await this.git.commit('docs', 'evaluator', 'final acceptance report', {
      allowProtectedBranchCommit: true,
    });
    await this.git.createTag('v1.0.0-release-candidate');

    this.metrics.endPhase('FINAL_ACCEPTANCE');
    this.saveCheckpoint(HarnessState.FINAL_ACCEPTANCE);
    this.log('全量验收完成');
  }

  // ============ Step 6: Release ============

  private async release(): Promise<void> {
    this.metrics.startPhase('RELEASE');
    this.log('>>> RELEASE - 发布交付');
    this.stateMachine.transitionMeta(HarnessState.RELEASE);
    this.stateMachine.transitionProject(HarnessState.RELEASE);

    // M-08: Generate delivery documentation (README.md and startup guide)
    await this.generateDeliveryDocs();

    // Update isolation metrics
    this.metrics.updateIsolationMetrics(this.isolationMonitor);

    // Generate comprehensive summary report using MetricsCollector
    this.metrics.generateReport(this.targetDir);

    this.validateReleaseEvidenceOrThrow();

    this.assertPostCondition(HarnessState.RELEASE);

    await this.git.addAll();
    await this.git.commit('docs', 'project', 'project summary report with full metrics and delivery docs', {
      allowProtectedBranchCommit: true,
    });

    await this.git.mergeBranch('dev', 'main');
    await this.git.createTag('v1.0.0-release');

    this.metrics.endPhase('RELEASE');
    this.saveCheckpoint(HarnessState.RELEASE);
    this.stateMachine.transitionMeta(HarnessState.FINISHED);
    this.stateMachine.transitionProject(HarnessState.FINISHED);
    this.clearResumeArtifacts();

    const tokens = this.client.getTokenUsage();
    this.log(`\n${'='.repeat(60)}`);
    this.log('Harness 元程序执行完成!');
    this.log(`项目目录: ${this.targetDir}`);
    this.log(`总 Token: ${tokens.total}`);
    this.log(`隔离合规: ${this.isolationMonitor.getMetrics().complianceRate.toFixed(1)}%`);
    this.log(`异常自愈率: ${this.exceptionHandler.getMetrics().selfHealRate.toFixed(1)}%`);
    this.log(`${'='.repeat(60)}`);
  }

  /**
   * M-08: Generate delivery documentation for the target project.
   * Uses the LLM to inspect the project structure and generate a README.md
   * with project overview, installation, running, and testing instructions.
   */
  private async generateDeliveryDocs(): Promise<void> {
    this.log('生成交付文档 (README.md)...');

    const prompt = `请为目标项目生成交付文档。请按以下步骤操作：

1. 使用 glob 查看 "src/" 目录下的文件结构
2. 使用 file_read 查看 "package.json"（如果存在）识别技术栈和脚本
3. 使用 file_read 查看 "docs/plan/product_spec.md" 了解项目概述
4. 使用 file_read 查看 "docs/plan/architecture_design.md" 了解架构

然后使用 file_write 将 README.md 写入项目根目录，包含以下内容：
- 项目名称与概述（基于 product_spec）
- 技术栈说明
- 安装步骤（如何安装依赖）
- 如何运行项目
- 如何运行测试
- 项目目录结构说明

⚠️ 路径约定：file_write 的 path 使用 "README.md"（项目根目录）`;

    let fallbackReason: string | undefined;
    try {
      await this.client.chatWithTools(
        [{ role: 'user', content: prompt }],
        this.toolRegistry.toLLMTools(),
        (call) => this.toolRegistry.execute(call),
      );
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
      this.log(`交付文档生成失败: ${fallbackReason}, 切换到确定性兜底生成`);
    }

    this.ensureDeliveryReadme(fallbackReason);
    this.log('交付文档生成完成');
  }

  // ============ Helpers ============

  /**
   * Recovery: Reset meta and project states to SPRINT_DISPATCH if either
   * is stuck in EXCEPTION_HANDLE or MANUAL_INTERVENTION. This prevents
   * invalid state transitions when retrying after a rollback failure.
   */
  private resetToSprintDispatchIfNeeded(): void {
    const meta = this.stateMachine.getMetaState().currentState;
    const project = this.stateMachine.getProjectState().currentState;
    const needsReset = [HarnessState.EXCEPTION_HANDLE, HarnessState.MANUAL_INTERVENTION];

    if (needsReset.includes(meta) || needsReset.includes(project)) {
      this.metaLogger.info('Resetting state to SPRINT_DISPATCH for sprint retry', {
        metaState: meta,
        projectState: project,
      });
      this.stateMachine.forceSetState(HarnessState.SPRINT_DISPATCH, `sprint retry recovery: meta=${meta} project=${project}`);
    }
  }

  /**
   * M-01: Determine if a phase should be skipped based on checkpoint state.
   * Returns true if the checkpoint state is past (at or after) the current phase.
   * This enables checkpoint resume (断点续跑) by skipping already-completed phases.
   */
  private shouldSkipPhase(checkpointState: HarnessState | undefined, currentPhase: HarnessState): boolean {
    if (!checkpointState) return false;

    const sprintSubStates: HarnessState[] = [
      HarnessState.SPRINT_NEGOTIATION,
      HarnessState.DEV,
      HarnessState.PRE_EVALUATION,
      HarnessState.EVALUATION,
      HarnessState.SPRINT_MERGE,
    ];

    // If checkpoint is at a sprint sub-state, we must NOT skip SPRINT_DISPATCH
    // because the sprint loop needs to run and will handle sub-state resume internally.
    if (sprintSubStates.includes(checkpointState)) {
      // For sprint sub-states: skip everything before SPRINT_DISPATCH, but not SPRINT_DISPATCH itself
      const preSprintPhases: HarnessState[] = [
        HarnessState.META_INIT,
        HarnessState.PROJECT_INIT,
        HarnessState.REQUIREMENT_PARSE,
        HarnessState.PLANNING,
      ];
      return preSprintPhases.includes(currentPhase);
    }

    // Define the FSM state order for top-level phases in the run() method
    const phaseOrder: HarnessState[] = [
      HarnessState.META_INIT,
      HarnessState.PROJECT_INIT,
      HarnessState.REQUIREMENT_PARSE,
      HarnessState.PLANNING,
      HarnessState.SPRINT_DISPATCH,
      HarnessState.FINAL_ACCEPTANCE,
      HarnessState.RELEASE,
    ];

    const checkpointIdx = phaseOrder.indexOf(checkpointState);
    const currentIdx = phaseOrder.indexOf(currentPhase);

    // If checkpoint state is past the current phase, skip it
    if (checkpointIdx >= 0 && currentIdx >= 0 && checkpointIdx >= currentIdx) {
      return true;
    }

    return false;
  }

  private normalizeCheckpointState(state: HarnessState): HarnessState {
    const sprintSubStates: HarnessState[] = [
      HarnessState.SPRINT_NEGOTIATION,
      HarnessState.DEV,
      HarnessState.PRE_EVALUATION,
      HarnessState.EVALUATION,
      HarnessState.SPRINT_MERGE,
    ];

    if (sprintSubStates.includes(state)) {
      return HarnessState.SPRINT_DISPATCH;
    }

    return state;
  }

  private assertFinalAcceptanceReady(): void {
    const sprintPlanPath = resolve(this.targetDir, 'docs/plan/sprint_plan.md');
    if (!existsSync(sprintPlanPath)) {
      throw new Error('Final acceptance blocked: sprint_plan.md is missing');
    }

    const sprintPlan = readFileSync(sprintPlanPath, 'utf-8');
    const plannedSprintIds = this.parseSprintIds(sprintPlan);
    const projectState = this.stateMachine.getProjectState();
    const completed = new Set(projectState.completedSprints);
    const incomplete = plannedSprintIds.filter(sprintId => !completed.has(sprintId));

    if (projectState.currentSprintId) {
      throw new Error(`Final acceptance blocked: sprint ${projectState.currentSprintId} is still in progress`);
    }

    if (incomplete.length > 0) {
      throw new Error(`Final acceptance blocked: incomplete sprints remain (${incomplete.join(', ')})`);
    }
  }

  private restoreCheckpointState(checkpoint: Checkpoint): void {
    this.stateMachine.restoreFromCheckpoint(checkpoint);
  }

  private buildSprintExecutionOrder(sprintIds: string[]): string[] {
    const projectState = this.stateMachine.getProjectState();
    const completed = new Set(projectState.completedSprints);
    const pending = sprintIds.filter(sprintId => !completed.has(sprintId));

    if (!projectState.currentSprintId || completed.has(projectState.currentSprintId)) {
      return pending;
    }

    const prioritized = pending.filter(sprintId => sprintId !== projectState.currentSprintId);
    return [projectState.currentSprintId, ...prioritized];
  }

  private clearResumeArtifacts(): void {
    this.checkpointManager.clear();
    this.metaLogger.info('Checkpoint artifacts cleared after successful release');
  }

  private validateFinalAcceptanceReportOrThrow(fallbackReason?: string): void {
    const reportPath = resolve(this.targetDir, 'docs/report/final_acceptance_report.md');
    const existing = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';

    if (!this.isFinalAcceptanceReportComplete(existing)) {
      throw new Error(
        `Final acceptance report missing or incomplete${fallbackReason ? `: ${fallbackReason}` : ''}`,
      );
    }

    if (!this.isFinalAcceptanceReportPassing(existing)) {
      throw new Error(
        `Final acceptance report does not record a passing conclusion${fallbackReason ? `: ${fallbackReason}` : ''}`,
      );
    }
  }

  private ensureDeliveryReadme(fallbackReason?: string): void {
    const readmePath = resolve(this.targetDir, 'README.md');
    const existing = existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : '';

    if (this.isDeliveryReadmeComplete(existing)) {
      return;
    }

    writeFileSync(readmePath, this.buildDeterministicReadme(fallbackReason), 'utf-8');
    this.projectLogger.warn('README completed by deterministic fallback', {
      fallbackReason: fallbackReason ?? 'missing-or-incomplete-readme',
    });
  }

  private isFinalAcceptanceReportComplete(content: string): boolean {
    const requiredSections = [
      '全量验收',
      '验收范围',
      '核心功能覆盖',
      '质量与风险',
      '验收结论',
    ];

    return normalizedIncludes(content, 'v1.0.0-release-candidate')
      && requiredSections.every(section => this.hasMeaningfulMarkdownSection(content, section, section === '验收结论' ? 4 : 6));
  }

  private isFinalAcceptanceReportPassing(content: string): boolean {
    const failPattern = /验收结论[\s\S]{0,200}(不通过|未通过|拒绝发布)/i;
    const passPattern = /验收结论[\s\S]{0,200}(通过|允许进入\s*RELEASE|可发布)/i;

    if (failPattern.test(content)) return false;
    return passPattern.test(content);
  }

  private isDeliveryReadmeComplete(content: string): boolean {
    if (!/^#\s+\S+/m.test(content)) return false;

    return this.hasExecutableReadmeSection(content, '安装')
      && this.hasExecutableReadmeSection(content, '运行')
      && this.hasExecutableReadmeSection(content, '测试')
      && this.hasStructureReadmeSection(content, '项目结构');
  }

  private validateReleaseEvidenceOrThrow(): void {
    const finalAcceptancePath = resolve(this.targetDir, 'docs/report/final_acceptance_report.md');
    const finalAcceptance = existsSync(finalAcceptancePath) ? readFileSync(finalAcceptancePath, 'utf-8') : '';
    if (!this.isFinalAcceptanceReportComplete(finalAcceptance)) {
      throw new Error('Release evidence incomplete: final acceptance report is missing or incomplete');
    }
    if (!this.isFinalAcceptanceReportPassing(finalAcceptance)) {
      throw new Error('Release evidence incomplete: final acceptance report does not record a passing conclusion');
    }

    const readmePath = resolve(this.targetDir, 'README.md');
    const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : '';
    if (!this.isDeliveryReadmeComplete(readme)) {
      throw new Error('Release evidence incomplete: README is missing or incomplete');
    }

    const summaryPath = resolve(this.targetDir, 'docs/report/project_summary_report.md');
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf-8') : '';
    const requiredSummarySections = [
      '项目基本信息',
      'Sprint执行情况汇总',
      '项目交付物清单',
      '总结与归档说明',
    ];
    const missingSections = requiredSummarySections.filter(section => !this.hasMeaningfulMarkdownSection(summary, section, 6));
    if (missingSections.length > 0) {
      throw new Error(`Release evidence incomplete: project summary report missing sections: ${missingSections.join(', ')}`);
    }
  }

  private extractMarkdownSection(content: string, heading: string): string | null {
    const pattern = new RegExp(`^(#{1,4})\\s+.*${heading}.*$`, 'm');
    const match = content.match(pattern);
    if (!match || match.index === undefined) return null;

    const level = match[1].length;
    const startIdx = match.index + match[0].length;
    const rest = content.substring(startIdx);
    const lines = rest.split('\n');
    let endIdx = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,4})\s+/);
      if (headingMatch && headingMatch[1].length <= level) {
        break;
      }
      endIdx += line.length + 1;
    }

    return rest.substring(0, endIdx).trim();
  }

  private hasMeaningfulMarkdownSection(content: string, heading: string, minLength = 10): boolean {
    const section = this.extractMarkdownSection(content, heading);
    if (!section) return false;

    const normalized = section
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^#{1,6}\s/.test(line))
      .map(line => line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
      .join(' ')
      .replace(/[`*_>|]/g, '')
      .trim();

    if (!normalized || normalized.length < minLength) return false;
    if (/^(todo|tbd|待补充|待确认|n\/a|无|none)$/i.test(normalized)) return false;
    return /[A-Za-z0-9\u4e00-\u9fff]/.test(normalized);
  }

  private hasExecutableReadmeSection(content: string, heading: string): boolean {
    const section = this.extractMarkdownSection(content, heading);
    if (!section) return false;

    if (!this.hasMeaningfulMarkdownSection(content, heading, 4)) return false;

    return /```[\s\S]*?```/.test(section)
      || /\b(npm|pnpm|yarn|bun|node|npx|python|pip|uv|poetry|go|cargo|make|docker)\b/i.test(section);
  }

  private hasStructureReadmeSection(content: string, heading: string): boolean {
    const section = this.extractMarkdownSection(content, heading);
    if (!section) return false;

    if (!this.hasMeaningfulMarkdownSection(content, heading, 4)) return false;

    return /^[\s>*-]*[A-Za-z0-9_.-]+\/?/m.test(section)
      || /src\/|test\/|docs\/|package\.json/i.test(section);
  }

  private buildDeterministicFinalAcceptanceReport(productSpec: string, fallbackReason?: string): string {
    const packageInfo = this.readPackageInfo();
    const structure = this.describeProjectStructure();
    const testCommand = packageInfo.scripts?.test ? 'npm run test' : '项目未声明 test 脚本，需按技术栈手动补充';

    return `# Final Acceptance Report

## 全量验收
- 生成方式: ${fallbackReason ? '确定性兜底生成' : '自动补全'}
- 版本候选: v1.0.0-release-candidate
- 目标目录: ${this.targetDir}
- 备注: ${fallbackReason ?? 'LLM 已执行，但输出缺失或不完整，已自动补全'}

## 验收范围
- 核心依据: docs/plan/product_spec.md
- 核心依据摘要:

${this.truncateText(productSpec, 1200)}

## 核心功能覆盖
- 已检查目录: src/、test/、docs/
- README 状态: ${existsSync(resolve(this.targetDir, 'README.md')) ? '已存在' : '待生成'}
- package.json 状态: ${existsSync(resolve(this.targetDir, 'package.json')) ? '已存在' : '缺失'}

## 质量与风险
- 推荐测试命令: ${testCommand}
- 当前项目结构:
${structure.map(item => `  - ${item}`).join('\n')}
- 风险说明: 若需完整发布验收，建议继续补跑集成测试、性能测试和安全扫描。

## 验收结论
- 结论: 已生成 final_acceptance_report.md，可继续进入 RELEASE。
- 下一步: 合并 dev -> main，打正式发布 Tag，并生成交付文档。
`;
  }

  private buildDeterministicReadme(fallbackReason?: string): string {
    const productSpec = this.readIfExists(resolve(this.targetDir, 'docs/plan/product_spec.md')) || '暂无产品规格摘要。';
    const packageInfo = this.readPackageInfo();
    const projectName = packageInfo.name || this.extractProjectName(productSpec) || 'target-project';
    const installCommand = existsSync(resolve(this.targetDir, 'package-lock.json')) ? 'npm install' : '按技术栈安装依赖';
    const runCommand = packageInfo.scripts?.start
      ? 'npm run start'
      : packageInfo.scripts?.dev
        ? 'npm run dev'
        : '请根据项目入口文件手动启动';
    const testCommand = packageInfo.scripts?.test ? 'npm run test' : '项目暂未声明 test 脚本';
    const structure = this.describeProjectStructure();

    return `# ${projectName}

> 本 README 由框架自动生成${fallbackReason ? `（兜底原因: ${fallbackReason}）` : ''}。

## 项目概述

${this.truncateText(productSpec, 800)}

## 技术栈

- 包管理与脚本: ${existsSync(resolve(this.targetDir, 'package.json')) ? 'package.json 已存在' : '未检测到 package.json'}
- 运行命令候选: ${runCommand}

## 安装

\`\`\`bash
${installCommand}
\`\`\`

## 运行

\`\`\`bash
${runCommand}
\`\`\`

## 测试

\`\`\`bash
${testCommand}
\`\`\`

## 项目结构

${structure.map(item => `- ${item}`).join('\n')}
`;
  }

  private describeProjectStructure(): string[] {
    const candidates = ['src', 'test', 'docs'];
    const lines: string[] = [];

    for (const entry of candidates) {
      const fullPath = resolve(this.targetDir, entry);
      if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
        continue;
      }

      lines.push(`${entry}/`);
      const children = readdirSync(fullPath).slice(0, 8);
      for (const child of children) {
        const childPath = resolve(fullPath, child);
        lines.push(`  ${entry}/${child}${statSync(childPath).isDirectory() ? '/' : ''}`);
      }
    }

    return lines.length > 0 ? lines : ['项目结构尚未生成'];
  }

  private readPackageInfo(): {
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
  } {
    const packagePath = resolve(this.targetDir, 'package.json');
    if (!existsSync(packagePath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(packagePath, 'utf-8')) as {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      };
    } catch {
      return {};
    }
  }

  private readIfExists(filePath: string): string | null {
    if (!existsSync(filePath)) {
      return null;
    }

    return readFileSync(filePath, 'utf-8');
  }

  private extractProjectName(productSpec: string): string | null {
    const titleMatch = productSpec.match(/^#\s+(.+)$/m);
    return titleMatch?.[1]?.trim() ?? null;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength)}...`;
  }

  private saveCheckpoint(state: HarnessState, sprintIteration?: number): void {
    const sprintSubStates: HarnessState[] = [
      HarnessState.SPRINT_NEGOTIATION,
      HarnessState.DEV,
      HarnessState.PRE_EVALUATION,
      HarnessState.EVALUATION,
      HarnessState.SPRINT_MERGE,
    ];

    // Inherit iteration from previous checkpoint if not explicitly provided
    // Only inherit within the SAME sprint to avoid cross-sprint contamination
    let resolvedIteration = sprintIteration;
    if (resolvedIteration === undefined && sprintSubStates.includes(state)) {
      const prev = this.checkpointManager.getLatest();
      const currentSprint = this.stateMachine.getProjectState().currentSprintId;
      if (prev?.currentSprintId === currentSprint) {
        resolvedIteration = prev?.sprintIteration;
      }
    }

    this.checkpointManager.save({
      id: `CP-${Date.now()}`,
      timestamp: new Date().toISOString(),
      state,
      currentSprintId: this.stateMachine.getProjectState().currentSprintId,
      completedSprints: this.stateMachine.getProjectState().completedSprints,
      meta: this.stateMachine.getMetaState().metrics,
      gitInfo: {
        currentBranch: '(tracked separately)',
        lastCommit: '(tracked separately)',
        tags: this.stateMachine.getProjectState().milestoneTags,
      },
      sprintSubState: sprintSubStates.includes(state) ? state : undefined,
      sprintIteration: resolvedIteration,
    });
  }

  /**
   * Post-condition assertion for each phase.
   * Called after a phase completes to verify that required artifacts exist
   * and are structurally valid. Throws on failure to block further progress.
   */
  private assertPostCondition(phase: HarnessState, context?: { sprintId?: string }): void {
    const errors: string[] = [];

    switch (phase) {
      case HarnessState.PROJECT_INIT: {
        if (!existsSync(resolve(this.targetDir, '.git'))) {
          errors.push('Post-condition: git repository not found after PROJECT_INIT');
        }
        if (!existsSync(resolve(this.targetDir, 'idea.md'))) {
          errors.push('Post-condition: idea.md not found after PROJECT_INIT');
        }
        for (const dir of ['docs/plan', 'docs/sprint', 'docs/report', 'src', 'test']) {
          if (!existsSync(resolve(this.targetDir, dir))) {
            errors.push(`Post-condition: required directory ${dir} not found after PROJECT_INIT`);
          }
        }
        if (!existsSync(resolve(this.targetDir, '.gitignore'))) {
          errors.push('Post-condition: .gitignore not found after PROJECT_INIT');
        }
        break;
      }
      case HarnessState.REQUIREMENT_PARSE: {
        const reqPath = resolve(this.targetDir, 'standard_requirement.md');
        if (!existsSync(reqPath)) {
          errors.push('Post-condition: standard_requirement.md not found after REQUIREMENT_PARSE');
        } else {
          const validation = this.artifactValidator.validateFile(reqPath);
          if (!validation.valid) {
            errors.push(`Post-condition: standard_requirement.md failed validation: ${validation.errors.join('; ')}`);
          }
        }
        break;
      }
      case HarnessState.PLANNING: {
        const planDir = resolve(this.targetDir, 'docs/plan');
        const requiredDocs = [
          'product_spec.md', 'architecture_design.md',
          'project_structure.md', 'code_standard.md', 'sprint_plan.md',
        ];
        for (const doc of requiredDocs) {
          const docPath = resolve(planDir, doc);
          if (!existsSync(docPath)) {
            errors.push(`Post-condition: planning doc ${doc} not found after PLANNING`);
          } else {
            const validation = this.artifactValidator.validateFile(docPath);
            if (!validation.valid) {
              errors.push(`Post-condition: ${doc} failed validation: ${validation.errors.join('; ')}`);
            }
          }
        }
        break;
      }
      case HarnessState.SPRINT_MERGE: {
        if (context?.sprintId) {
          const tagPattern = this.formatSprintCompletionMilestone(context.sprintId);
          const tags = this.stateMachine.getProjectState().milestoneTags;
          if (!tags.some(t => t.includes(tagPattern))) {
            errors.push(`Post-condition: milestone tag for ${context.sprintId} not recorded after SPRINT_MERGE`);
          }
        }
        break;
      }
      case HarnessState.FINAL_ACCEPTANCE: {
        const reportPath = resolve(this.targetDir, 'docs/report/final_acceptance_report.md');
        if (!existsSync(reportPath)) {
          errors.push('Post-condition: final_acceptance_report.md not found after FINAL_ACCEPTANCE');
        } else {
          const content = readFileSync(reportPath, 'utf-8');
          if (!this.isFinalAcceptanceReportComplete(content)) {
            errors.push('Post-condition: final_acceptance_report.md is incomplete after FINAL_ACCEPTANCE');
          }
          if (!this.isFinalAcceptanceReportPassing(content)) {
            errors.push('Post-condition: final_acceptance_report.md does not record a passing conclusion');
          }
        }
        break;
      }
      case HarnessState.RELEASE: {
        const readmePath = resolve(this.targetDir, 'README.md');
        if (!existsSync(readmePath)) {
          errors.push('Post-condition: README.md not found after RELEASE');
        } else {
          const content = readFileSync(readmePath, 'utf-8');
          if (!this.isDeliveryReadmeComplete(content)) {
            errors.push('Post-condition: README.md is incomplete after RELEASE');
          }
        }
        const summaryPath = resolve(this.targetDir, 'docs/report/project_summary_report.md');
        if (!existsSync(summaryPath)) {
          errors.push('Post-condition: project_summary_report.md not found after RELEASE');
        } else {
          const summary = readFileSync(summaryPath, 'utf-8');
          const requiredSections = [
            '项目基本信息',
            'Sprint执行情况汇总',
            '项目交付物清单',
            '总结与归档说明',
          ];
          const missingSections = requiredSections.filter(section => !this.hasMeaningfulMarkdownSection(summary, section, 6));
          if (missingSections.length > 0) {
            errors.push(`Post-condition: project_summary_report.md missing sections after RELEASE: ${missingSections.join(', ')}`);
          }
        }
        break;
      }
      case HarnessState.SPRINT_NEGOTIATION: {
        if (context?.sprintId) {
          const contractPath = resolve(this.targetDir, `docs/sprint/sprint_contract_${context.sprintId}.md`);
          if (!existsSync(contractPath)) {
            errors.push(`Post-condition: sprint contract not found after SPRINT_NEGOTIATION for ${context.sprintId}`);
          } else {
            const validation = this.artifactValidator.validateSprintContract(contractPath);
            if (!validation.valid) {
              errors.push(`Post-condition: sprint contract invalid after SPRINT_NEGOTIATION: ${validation.errors.join('; ')}`);
            }
          }
        }
        break;
      }
      case HarnessState.EVALUATION: {
        if (context?.sprintId) {
          const reviewPath = resolve(this.targetDir, `docs/sprint/review_report_${context.sprintId}.md`);
          if (!existsSync(reviewPath)) {
            errors.push(`Post-condition: review report not found after EVALUATION for ${context.sprintId}`);
          } else {
            const validation = this.artifactValidator.validateReviewReport(reviewPath);
            if (!validation.valid) {
              errors.push(`Post-condition: review report invalid after EVALUATION: ${validation.errors.join('; ')}`);
            }
          }
        }
        break;
      }
      default:
        // No post-condition for this phase
        break;
    }

    if (errors.length > 0) {
      throw new Error(`Phase ${phase} post-condition failed:\n${errors.join('\n')}`);    }
  }

  private parseSprintIds(sprintPlan: string): string[] {
    const matches = sprintPlan.match(/sprint-\d+/gi);
    if (!matches || matches.length === 0) {
      throw new Error('无法从 sprint_plan.md 中解析出任何 Sprint ID。请确保 Sprint 计划包含 "sprint-XX" 格式的标识');
    }
    return [...new Set(matches.map(m => m.toLowerCase()))];
  }

  private normalizeSprintId(sprintId: string): string {
    const normalized = sprintId.trim().toLowerCase();
    if (normalized.startsWith('sprint-')) return normalized;
    return `sprint-${normalized}`;
  }

  private formatSprintCompletionMilestone(sprintId: string): string {
    return `${this.normalizeSprintId(sprintId)}-complete`;
  }

  private formatSprintCompletionTag(sprintId: string): string {
    return `v0.${this.parseSprintNumber(sprintId)}.0-${this.formatSprintCompletionMilestone(sprintId)}`;
  }

  private parseSprintNumber(sprintId: string): number {
    const match = sprintId.match(/\d+/);
    return match ? parseInt(match[0]) : 1;
  }

  private extractSprintSection(sprintPlan: string, sprintId: string): string {
    const lines = sprintPlan.split('\n');
    let inSection = false;
    const section: string[] = [];
    // Use word boundary to avoid sprint-1 matching sprint-10
    const sprintPattern = new RegExp(`\\b${sprintId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

    for (const line of lines) {
      if (sprintPattern.test(line)) inSection = true;
      if (inSection) {
        section.push(line);
        if (section.length > 5 && line.match(/^#{1,3}\s/) && !sprintPattern.test(line)) break;
      }
    }

    return section.length > 0 ? section.join('\n') : sprintPlan;
  }

  /**
   * Structured evaluation result checking using parsed review report data.
   * Replaces fragile regex-based checking with deterministic object-level validation.
   */
  private checkEvaluationPassed(reviewReport: string): boolean {
    // 1. Parse structured data — extractReviewReportData tries JSON block first, then regex fallback
    let structured: { sprintId: string; passed: boolean; scores: Array<{ dimension: string; score: number }>; weightedAverage: number };
    if (this.artifactValidator) {
      structured = this.artifactValidator.extractReviewReportData(reviewReport);
    } else {
      // Fallback for cases where infrastructure is not yet initialized
      const scoreMatch = reviewReport.match(/整体加权平均分[:：]\s*(\d+\.?\d*)/);
      structured = {
        sprintId: '',
        passed: normalizedIncludes(reviewReport, '通过') && !normalizedIncludes(reviewReport, '不通过'),
        scores: this.extractDimensionScores(reviewReport)
          ? [...this.extractDimensionScores(reviewReport).entries()].map(([dimension, score]) => ({ dimension, score }))
          : [],
        weightedAverage: scoreMatch ? parseFloat(scoreMatch[1]) : NaN,
      };
    }

    // 2. Validate extracted scores have correct types
    if (structured.scores.length > 0) {
      for (const s of structured.scores) {
        if (typeof s.dimension !== 'string' || typeof s.score !== 'number') {
          this.log('WARNING: review report score entry failed basic validation, treating as not passed');
          return false;
        }
      }
    }

    // 3. Hard rule: explicit fail keyword overrides everything
    if (/验收结果[:：]\s*不通过|验收.*不通过/i.test(reviewReport)) return false;

    // 3. Hard rule: must have an explicit passing conclusion
    if (!structured.passed) {
      this.log('WARNING: 结构化解析未检测到通过结论, 默认不通过');
      return false;
    }

    // 4. Hard rule: weighted average must meet threshold
    if (Number.isNaN(structured.weightedAverage) || structured.weightedAverage < this.config.thresholds.evaluationPassScore) {
      this.log(`WARNING: 整体加权平均分 ${structured.weightedAverage} < ${this.config.thresholds.evaluationPassScore}, 不通过`);
      return false;
    }

    // 5. Hard rule: all 5 dimensions must be present and meet minimum score
    const requiredDimensions = EVALUATION_DIMENSIONS.map(d => d.canonical);

    const scoreMap = new Map(structured.scores.map(s => [s.dimension, s.score]));
    for (const dimension of requiredDimensions) {
      const score = scoreMap.get(dimension);
      if (score === undefined) {
        this.log(`WARNING: 缺少维度 "${dimension}" 的评分, 默认不通过`);
        return false;
      }
      if (score < this.config.thresholds.evaluationMinDimensionScore) {
        this.log(`维度 "${dimension}" 得分 ${score} < ${this.config.thresholds.evaluationMinDimensionScore}, 一票否决`);
        return false;
      }
    }

    return true;
  }

  private extractScore(reviewReport: string): number {
    const scoreMatch = reviewReport.match(/整体加权平均分[:：]\s*(\d+\.?\d*)/);
    if (scoreMatch) return parseFloat(scoreMatch[1]);
    this.log('WARNING: 无法提取评分, 记录为0');
    return 0;
  }

  private extractDimensionScores(reviewReport: string): Map<string, number> {
    const scores = new Map<string, number>();
    const dimensions = [
      '功能完整性',
      '代码质量与架构合规性',
      '可运行性与稳定性',
      '可测试性与文档完整性',
      '代码安全性',
    ];

    const tablePattern = /\|\s*(功能完整性|代码质量与架构合规性|可运行性与稳定性|可测试性与文档完整性|代码安全性)\s*\|\s*(\d+%?)\s*\|\s*(\d+\.?\d*)\s*\|\s*(\d+)\s*\|/g;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tablePattern.exec(reviewReport)) !== null) {
      scores.set(tableMatch[1], parseFloat(tableMatch[3]));
    }

    for (const dimension of dimensions) {
      if (scores.has(dimension)) continue;

      const escaped = dimension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bulletPattern = new RegExp(`[-*]\\s*${escaped}\\s*[:：]\\s*(\\d+\\.?\\d*)`, 'i');
      const bulletMatch = reviewReport.match(bulletPattern);
      if (bulletMatch) {
        scores.set(dimension, parseFloat(bulletMatch[1]));
      }
    }

    return scores;
  }

  private async getExistingCodeSummary(): Promise<string> {
    try {
      const status = await this.git.getStatus();
      const log = await this.git.getLog(10);
      return `Git Status:\n${status}\n\nRecent Commits:\n${log}`;
    } catch { return ''; }
  }

  private readFile(path: string): string {
    try {
      if (!existsSync(path)) {
        this.projectLogger.warn('File not found for reading', { path });
        return '';
      }
      return readFileSync(path, 'utf-8');
    } catch (err) {
      this.projectLogger.warn('Failed to read file', { path, error: err instanceof Error ? err.message : String(err) });
      return '';
    }
  }

  /**
   * Post-merge verification: run compilation and basic tests on dev branch
   * Required by framework spec SPRINT_MERGE state
   */
  private async runPostMergeVerification(): Promise<{ passed: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (existsSync(resolve(this.targetDir, 'tsconfig.json'))) {
      const result = await this.runProjectCommand('npx', ['tsc', '--noEmit'], 'TypeScript compilation', 60_000);
      if (!result.ok) issues.push(result.error);
    } else if (existsSync(resolve(this.targetDir, 'package.json')) && existsSync(resolve(this.targetDir, 'src/index.js'))) {
      const result = await this.runProjectCommand('node', ['--check', 'src/index.js'], 'Node.js syntax check', 30_000);
      if (!result.ok) issues.push(result.error);
    }

    const packageInfo = this.readPackageInfo();
    if (packageInfo.scripts?.build) {
      const result = await this.runProjectCommand('npm', ['run', 'build'], 'Build script', 120_000);
      if (!result.ok) issues.push(result.error);
    }
    if (packageInfo.scripts?.test) {
      const result = await this.runProjectCommand('npm', ['run', 'test'], 'Test script', 120_000);
      if (!result.ok) issues.push(result.error);
    }

    if ((existsSync(resolve(this.targetDir, 'pyproject.toml')) || existsSync(resolve(this.targetDir, 'setup.py'))) &&
        existsSync(resolve(this.targetDir, 'src/__init__.py'))) {
      const result = await this.runProjectCommand('python', ['-m', 'py_compile', 'src/__init__.py'], 'Python syntax check', 30_000);
      if (!result.ok) issues.push(result.error);
    }

    if (existsSync(resolve(this.targetDir, 'go.mod'))) {
      const result = await this.runProjectCommand('go', ['build', './...'], 'Go build', 60_000);
      if (!result.ok) issues.push(result.error);
    }

    return { passed: issues.length === 0, issues };
  }

  private async runProjectCommand(
    command: string,
    args: string[],
    label: string,
    timeout: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await execa(command, args, {
        cwd: this.targetDir,
        reject: false,
        timeout,
      });
      if (result.exitCode === 0) {
        return { ok: true };
      }

      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(0, 600);
      return { ok: false, error: `${label} failed: ${output}` };
    } catch (err) {
      return {
        ok: false,
        error: `${label} error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(chalk.blue(`[${timestamp}]`) + ` ${message}`);
  }
}
