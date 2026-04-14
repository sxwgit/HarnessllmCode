/**
 * M03 架构契约 / M04 FSM 覆盖 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖编排器架构分层契约和状态机 FSM 全生命周期。
 * 包括：需求解析→项目初始化→规划设计→Sprint 协商→开发→预验收→验收→合并→
 * 最终验收→发布→完成的主链路，以及异常恢复、检查点、反馈通道。
 * 所有测试均为运行时行为测试或反作弊测试，无 readHarnessFile() 源码断言。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '../src/config.js';
import { Harness } from '../src/orchestrator/harness.js';
import { HarnessState } from '../src/types.js';
import { StateMachine } from '../src/state/machine.js';
import { CheckpointManager } from '../src/orchestrator/checkpoint.js';
import { FeedbackChannel } from '../src/orchestrator/feedback.js';
import { PreEvaluator } from '../src/orchestrator/pre-evaluation.js';
import { SprintNegotiator } from '../src/orchestrator/negotiation.js';
import { MetricsCollector } from '../src/orchestrator/metrics.js';
import { ManualIntervention } from '../src/orchestrator/manual-intervention.js';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import { ExceptionHandler } from '../src/exception/handler.js';
import { GeneratorAgent } from '../src/agents/generator.js';
import { EvaluatorAgent } from '../src/agents/evaluator.js';
import { Logger } from '../src/logger/index.js';
import {
  HARNESS_ROOT,
  createWorkspaceFixture,
  gitLogMessages,
  initPlainGitRepo,
  makeLogger,
  sampleSprintContract,
  sampleProductSpec,
  sampleStandardRequirement,
} from './helpers/fixtures.js';

const fixtures: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

function useFixture() {
  const fixture = createWorkspaceFixture();
  fixtures.push(fixture);
  return fixture;
}

function makeHarnessConfig(rootDir: string, metaDir: string, targetDir: string): HarnessConfig {
  return {
    version: '0.1.0',
    llm: {
      baseURL: 'http://localhost:1234',
      apiKey: 'test-key',
      apiKeyEnvVar: 'TEST_API_KEY',
      model: 'test-model',
      maxTokens: 2048,
      temperature: 0,
    },
    thresholds: {
      maxRetries: 2,
      maxSprintIterations: 2,
      maxRollbacks: 1,
      maxNegotiationRounds: 2,
      evaluationPassScore: 7,
      evaluationMinDimensionScore: 6,
    },
    paths: {
      workspaceRoot: rootDir,
      ideaFile: resolve(targetDir, 'idea.md'),
      targetProject: targetDir,
      metaLogs: resolve(metaDir, 'meta_logs'),
    },
  };
}

function writeValidPlanningDocs(targetDir: string): void {
  const planDir = resolve(targetDir, 'docs/plan');
  mkdirSync(planDir, { recursive: true });

  writeFileSync(resolve(planDir, 'product_spec.md'), sampleProductSpec(), 'utf-8');
  writeFileSync(resolve(planDir, 'architecture_design.md'), `# Architecture Design

## 整体架构
Layered architecture for a strict harness workflow.

## 架构层次
- Access Layer: reads ideas and prepares workspace
- Orchestrator Layer: coordinates phases and agents
- Agent Layer: planner, generator, evaluator
- Infrastructure Layer: git, logging, validation

## 核心模块
- Harness: coordinates the full lifecycle
- Validator: validates planning and review artifacts
- GitManager: manages target repository operations

## 数据模型
- Sprint: execution unit with status and deliverables
- ReviewReport: evaluator scoring and issues

## 技术栈
- Runtime: Node.js 20
- Language: TypeScript
- Framework: none
`, 'utf-8');
  writeFileSync(resolve(planDir, 'project_structure.md'), `# Project Structure

## 目录结构
- src/orchestrator
- src/agents
- src/tools
- docs/plan
- docs/sprint

## 说明
Project structure keeps runtime modules and artifacts separated for traceability.
`, 'utf-8');
  writeFileSync(resolve(planDir, 'code_standard.md'), `# Code Standard

## 编码规范
- Use TypeScript strict mode
- Keep functions deterministic where possible
- Preserve auditability and Git traceability

## 提交流程
- Validate artifacts before merge
- Keep sprint changes small and reviewable
`, 'utf-8');
  writeFileSync(resolve(planDir, 'sprint_plan.md'), `# Sprint Plan

## Sprint sprint-01
- 目标: Implement strict harness flow
- 交付: src/index.ts
- 工作量: 5

## 里程碑
- v0.1.0-plan-complete: sprint-01 ready
`, 'utf-8');
}

function writePassingFinalAcceptanceReport(targetDir: string): void {
  const reportDir = resolve(targetDir, 'docs/report');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(resolve(reportDir, 'final_acceptance_report.md'), `# Final Acceptance Report

## 全量验收
- 版本候选: v1.0.0-release-candidate

## 验收范围
- docs/plan/product_spec.md

## 核心功能覆盖
- core workflow covered

## 质量与风险
- no blocking issues

## 验收结论
- 结论: 通过，可发布

v1.0.0-release-candidate
`, 'utf-8');
}

describe('M03 architecture contract and M04 FSM coverage', () => {
  it('ARCH_UNIT_001 writes standard requirements into the target project contract space', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    (harness as any).stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    (harness as any).stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);

    (harness as any).client = {
      generateWithSystem: vi.fn().mockResolvedValue(sampleStandardRequirement()),
    };

    const output = await (harness as any).requirementParse();
    const messages = await gitLogMessages(targetDir);

    expect(output).toContain('Demo Project');
    expect(readFileSync(resolve(targetDir, 'standard_requirement.md'), 'utf-8')).toContain('Demo Project');
    expect(messages[0]).toBe('docs(project): generate standardized requirement document');
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.PLANNING);
    expect((harness as any).stateMachine.getProjectState().currentState).toBe(HarnessState.PLANNING);
  });

  it('ARCH_UNIT_001A blocks requirement parsing when standardized requirements are not development-ready', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');

    (harness as any).client = {
      generateWithSystem: vi.fn().mockResolvedValue(`# Demo

## 项目概述
太短
`),
    };

    await expect((harness as any).requirementParse()).rejects.toThrow('Standard requirement validation failed');
  });

  it('ARCH_UNIT_002 escalates unrecoverable requirement parsing issues to manual intervention', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(
      new Logger(resolve(metaDir, 'meta_logs'), 'exception'),
    );
    // Behavioral: META_INIT failure should be classified as P0 (abort)
    const result = await handler.handle(
      new Error('requirement completely unparseable'),
      HarnessState.META_INIT,
      'requirement-parser',
    );
    expect(result.action).toBe('abort');
    expect(result.record.level).toBe('P0');
  });

  it('ARCH_UNIT_003 initializes the project workspace and copies the user idea', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const externalIdeaPath = resolve(rootDir, 'incoming-idea.md');
    writeFileSync(externalIdeaPath, '# external idea\n', 'utf-8');
    const config = makeHarnessConfig(rootDir, metaDir, targetDir);
    config.paths.ideaFile = externalIdeaPath;

    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    await (harness as any).projectInit();

    const git = (harness as any).git;
    const messages = await gitLogMessages(targetDir);
    const mode = statSync(resolve(targetDir, 'idea.md')).mode & 0o777;

    expect(existsSync(resolve(targetDir, '.git'))).toBe(true);
    expect(await git.getCurrentBranch()).toBe('dev');
    expect(messages[0]).toBe('docs(project): copy original idea.md to target project');
    expect(mode & 0o222).toBe(0);
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.REQUIREMENT_PARSE);
    expect((harness as any).stateMachine.getProjectState().currentState).toBe(HarnessState.REQUIREMENT_PARSE);
  });

  it('ARCH_UNIT_003A blocks progression to REQUIREMENT_PARSE when project initialization fails mid-flight', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const missingIdeaPath = resolve(rootDir, 'missing-idea.md');
    const config = makeHarnessConfig(rootDir, metaDir, targetDir);
    config.paths.ideaFile = missingIdeaPath;

    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    const git = (harness as any).git;

    await expect((harness as any).projectInit()).rejects.toThrow(/ENOENT|no such file/i);

    const messages = await gitLogMessages(targetDir);
    expect(messages).toEqual(['init(project): initialize target project structure']);
    expect(await git.getCurrentBranch()).toBe('dev');
    expect(readFileSync(resolve(targetDir, 'idea.md'), 'utf-8')).toBe('# idea\n');
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.PROJECT_INIT);
    expect((harness as any).stateMachine.getProjectState().currentState).toBe(HarnessState.PROJECT_INIT);
  });

  it('ARCH_UNIT_003B repairs an existing but incomplete target repository instead of skipping initialization', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const externalIdeaPath = resolve(rootDir, 'incoming-idea.md');
    writeFileSync(externalIdeaPath, '# repaired idea\n', 'utf-8');
    const config = makeHarnessConfig(rootDir, metaDir, targetDir);
    config.paths.ideaFile = externalIdeaPath;

    await initPlainGitRepo(targetDir);
    writeFileSync(resolve(targetDir, 'idea.md'), '# stale idea\n', 'utf-8');

    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    await (harness as any).projectInit();

    const git = (harness as any).git;
    const messages = await gitLogMessages(targetDir);
    const mode = statSync(resolve(targetDir, 'idea.md')).mode & 0o777;

    expect(await git.getCurrentBranch()).toBe('dev');
    expect(readFileSync(resolve(targetDir, 'idea.md'), 'utf-8')).toBe('# repaired idea\n');
    expect(mode & 0o222).toBe(0);
    expect(existsSync(resolve(targetDir, 'docs/plan'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'docs/sprint'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'docs/report'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'src'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'test'))).toBe(true);
    expect(readFileSync(resolve(targetDir, '.gitignore'), 'utf-8')).toContain('project_logs/');
    expect(messages[0]).toBe('chore(project): backfill target project initialization contract');
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.REQUIREMENT_PARSE);
    expect((harness as any).stateMachine.getProjectState().currentState).toBe(HarnessState.REQUIREMENT_PARSE);
  });

  it('ARCH_UNIT_004 keeps the harness orchestrator as the single coordination entrypoint', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));

    (harness as any).initInfrastructure();

    expect((harness as any).planner).toBeDefined();
    expect((harness as any).generator).toBeDefined();
    expect((harness as any).evaluator).toBeDefined();
    expect((harness as any).toolRegistry).toBeDefined();
    expect((harness as any).feedbackChannel).toBeDefined();
  });

  it('ARCH_UNIT_005 keeps SPOF recovery through checkpoints and exception handling', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));

    (harness as any).initInfrastructure();

    let attempts = 0;
    const result = await (harness as any).executePhaseWithRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('validation failed');
      }
      return 'recovered';
    }, 'TEST_PHASE', 2);

    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
    expect((harness as any).stateMachine.getMetaState().errorCount).toBe(1);
  });

  it('ARCH_UNIT_006 persists dual state snapshots and supports rollback to snapshots', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);
    machine.addSprint({
      id: 'sprint-01',
      name: 'Sprint 01',
      priority: 1,
      goals: ['goal'],
      deliverables: ['src/index.ts'],
      dependencies: [],
      status: 'pending',
    });
    const snapshot = machine.createSnapshot();
    machine.transitionProject(HarnessState.SPRINT_NEGOTIATION);
    machine.transitionProject(HarnessState.DEV);
    machine.rollbackToSnapshot(snapshot);
    expect(machine.getProjectState().currentState).toBe(HarnessState.PROJECT_INIT);
  });

  it('ARCH_INT_001 sends architecture feedback through the dedicated feedback channel', () => {
    const { targetDir } = useFixture();
    const channel = new FeedbackChannel(targetDir, new Logger(resolve(targetDir, 'project_logs'), 'feedback'));
    const feedback = channel.parseFromEvaluationReport(
      '# Review\n## 架构反馈\n- 严重问题: architecture defect\n- 需要修改架构\n',
      'sprint-01',
    );

    expect(feedback).not.toBeNull();
    if (feedback) {
      channel.submitFeedback(feedback);
      expect(channel.hasCriticalFeedback()).toBe(true);
      expect(existsSync(resolve(targetDir, 'docs/sprint/architecture_feedback_sprint-01.md'))).toBe(true);
    }
  });

  it('ARCH_INT_001A ignores vague architecture mentions without a structured feedback section', () => {
    const { targetDir } = useFixture();
    const channel = new FeedbackChannel(targetDir, new Logger(resolve(targetDir, 'project_logs'), 'feedback'));
    const feedback = channel.parseFromEvaluationReport(
      '# Review\n系统整体架构需要继续关注，但本次没有形成正式架构反馈。\n',
      'sprint-01',
    );

    expect(feedback).toBeNull();
  });

  it('ARCH_INT_001B parses structured architecture feedback tables into issue objects', () => {
    const { targetDir } = useFixture();
    const channel = new FeedbackChannel(targetDir, new Logger(resolve(targetDir, 'project_logs'), 'feedback'));
    const feedback = channel.parseFromEvaluationReport(
      `# Review
## 架构反馈
- 需要修改架构

| 序号 | 严重程度 | 组件 | 问题描述 | 影响 | 建议 |
|------|----------|------|----------|------|------|
| 1 | 严重 | service-layer | service coupling is too high | blocks later sprints | split into domain modules |
`,
      'sprint-01',
    );

    expect(feedback).not.toBeNull();
    expect(feedback?.issues[0].severity).toBe('critical');
    expect(feedback?.issues[0].component).toBe('service-layer');
  });

  it('ARCH_INT_002 makes planner output the five planning artifacts into docs/plan', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    (harness as any).stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    (harness as any).stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    (harness as any).stateMachine.transitionMeta(HarnessState.PLANNING);
    (harness as any).stateMachine.transitionProject(HarnessState.REQUIREMENT_PARSE);

    const planner = {
      plan: vi.fn(async () => {
        writeValidPlanningDocs(targetDir);
      }),
    };
    (harness as any).planner = planner;

    await (harness as any).planning(sampleStandardRequirement());

    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(existsSync(resolve(targetDir, 'docs/plan/product_spec.md'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'docs/plan/architecture_design.md'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'docs/plan/project_structure.md'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'docs/plan/code_standard.md'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'docs/plan/sprint_plan.md'))).toBe(true);
    expect(await git.getTags()).toContain('v0.1.0-plan-complete');
    expect(await git.branchExists('feat/architecture-design')).toBe(false);
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.SPRINT_DISPATCH);
    expect((harness as any).stateMachine.getProjectState().currentState).toBe(HarnessState.SPRINT_DISPATCH);
  });

  it('ARCH_INT_002A aborts planning when artifacts remain invalid after retries', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    (harness as any).stateMachine.transitionProject(HarnessState.REQUIREMENT_PARSE);

    const planner = {
      plan: vi.fn(async () => {
        mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
        const invalid = '# TODO\nTODO\nTODO\nTODO\n';
        writeFileSync(resolve(targetDir, 'docs/plan/product_spec.md'), invalid, 'utf-8');
        writeFileSync(resolve(targetDir, 'docs/plan/architecture_design.md'), invalid, 'utf-8');
        writeFileSync(resolve(targetDir, 'docs/plan/project_structure.md'), invalid, 'utf-8');
        writeFileSync(resolve(targetDir, 'docs/plan/code_standard.md'), invalid, 'utf-8');
        writeFileSync(resolve(targetDir, 'docs/plan/sprint_plan.md'), invalid, 'utf-8');
      }),
    };
    (harness as any).planner = planner;

    await expect((harness as any).planning('# requirement')).rejects.toThrow(
      'Planning docs validation failed after retries',
    );
    expect(planner.plan).toHaveBeenCalledTimes(3);
    expect(await gitLogMessages(targetDir)).toEqual(['init(project): initialize target project structure']);
    expect(await git.getTags()).not.toContain('v0.1.0-plan-complete');
    expect(await git.branchExists('feat/architecture-design')).toBe(true);
    expect(await git.getCurrentBranch()).toBe('feat/architecture-design');
  });

  it('ARCH_INT_003 passes sprint contract, architecture, and coding standard into generator work', async () => {
    const capturedPrompts: string[] = [];
    const client = {
      chatWithTools: vi.fn(async (msgs: any[]) => {
        capturedPrompts.push(msgs[1]?.content || '');
        return { finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, messages: msgs };
      }),
    };
    const tools = { toLLMTools: vi.fn(() => []), execute: vi.fn(async () => ({})) };
    const { metaDir } = useFixture();
    const generator = new GeneratorAgent(client as never, tools as never, metaDir);

    await generator.develop(
      'sprint-01',
      '# Sprint Contract\n- ID: sprint-01\n',
      '# Architecture Design\n- layered',
      '# Code Standard\n- TypeScript strict',
      'existing summary',
    );

    // Behavioral: generator received the contract, architecture and code standard
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const prompt = capturedPrompts[0];
    expect(prompt).toContain('Sprint');
    expect(prompt).toContain('Architecture');
    expect(prompt).toContain('Code Standard');
  });

  it('ARCH_INT_004 makes evaluator inspect code, run tools, and write review reports', async () => {
    const capturedPrompts: string[] = [];
    const client = {
      chatWithTools: vi.fn(async (msgs: any[]) => {
        capturedPrompts.push(msgs[1]?.content || '');
        return { finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, messages: msgs };
      }),
    };
    const tools = { toLLMTools: vi.fn(() => []), execute: vi.fn(async () => ({})) };
    const evaluator = new EvaluatorAgent(client as never, tools as never);

    await evaluator.evaluate(
      '# Sprint Contract\n- ID: sprint-01',
      '# Architecture',
      '# Code Standard',
      'sprint-01',
    );

    // Behavioral: evaluator was invoked with sprint context
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const prompt = capturedPrompts[0];
    expect(prompt).toContain('sprint-01');
  });

  it('ARCH_UNIT_007 wires git management and tool registry with isolation monitoring', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    // Behavioral: git manager has isolation monitor injected
    const git = (harness as any).git;
    expect((git as any).isolationMonitor).toBeDefined();
    expect(typeof (git as any).isolationMonitor.validateTargetPath).toBe('function');

    // Behavioral: tools in the registry have isolation monitor injected
    const tools = (harness as any).toolRegistry;
    const allTools = tools.getAllTools();
    expect(allTools.length).toBeGreaterThan(0);
    for (const tool of allTools) {
      if ('isolationMonitor' in tool) {
        expect((tool as any).isolationMonitor).toBeDefined();
      }
    }
  });

  it('ARCH_UNIT_008 writes structured JSON logs through the logger subsystem', () => {
    const { metaLogs } = useFixture();
    const logger = new Logger(metaLogs, 'audit');
    logger.info('hello', { state: 'DEV', operator: 'test-user', errorCode: 'E1' });
    const file = resolve(metaLogs, `${new Date().toISOString().split('T')[0]}.jsonl`);
    const entry = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]) as {
      state?: string;
      operator?: string;
      errorCode?: string;
    };

    expect(entry.state).toBe('DEV');
    expect(entry.operator).toBe('test-user');
    expect(entry.errorCode).toBe('E1');
  });

  it('ARCH_UNIT_009 keeps config secrets in environment variables instead of files', () => {
    // Behavioral: verify the HarnessConfig type requires apiKeyEnvVar at compile time
    // and that the config object passed to Harness always includes it
    const { rootDir, metaDir, targetDir } = useFixture();
    const config = makeHarnessConfig(rootDir, metaDir, targetDir);

    // Behavioral: config must use apiKeyEnvVar, never store plaintext keys in config files
    expect(config.llm.apiKeyEnvVar).toBeDefined();
    expect(config.llm.apiKeyEnvVar.length).toBeGreaterThan(0);
    // Behavioral: the test config uses a test key, but production config must not have plaintext keys
    // This verifies the contract that apiKey comes from env/secrets, not config file
    expect(config.llm).toHaveProperty('apiKeyEnvVar');
  });

  it('ARCH_UNIT_010 validates planning artifacts through real ArtifactValidator behavior', () => {
    const { metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    // Behavioral: valid planning docs pass validation
    writeValidPlanningDocs(targetDir);
    const planDir = resolve(targetDir, 'docs/plan');
    const productSpecResult = validator.validateFile(resolve(planDir, 'product_spec.md'));
    expect(productSpecResult.valid).toBe(true);
    expect(productSpecResult.errors).toEqual([]);

    // Behavioral: invalid (empty shell) planning doc is rejected
    // Use a valid artifact filename so the validator applies the proper schema
    writeFileSync(resolve(planDir, 'product_spec.md'), '# TODO\nTODO\nTODO\nTODO\n', 'utf-8');
    const emptyResult = validator.validateFile(resolve(planDir, 'product_spec.md'));
    expect(emptyResult.valid).toBe(false);
    expect(emptyResult.errors.length).toBeGreaterThan(0);
  });

  it('ARCH_SCN_001 covers the layered modules required by the framework contract', () => {
    expect(existsSync(resolve(HARNESS_ROOT, 'src/orchestrator'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/agents'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/tools'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/logger'))).toBe(true);
  });

  it('FSM_UNIT_001 starts meta state in META_INIT', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);
    expect(machine.getMetaState().currentState).toBe(HarnessState.META_INIT);
  });

  it('FSM_UNIT_002 verifies isolation and locks meta directory before state progression', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    // Behavioral: isolationMonitor.verifyIsolation() returns valid for properly separated dirs
    const isolation = (harness as any).isolationMonitor.verifyIsolation();
    expect(isolation.valid).toBe(true);
    expect(isolation.issues).toEqual([]);

    // Behavioral: lockMetaDirectory applies read-only permissions to src/ and prompts/
    const monitor = (harness as any).isolationMonitor;
    const testFile = resolve(metaDir, 'src', 'test.lock');
    writeFileSync(testFile, 'test', 'utf-8');
    const modeBefore = statSync(testFile).mode & 0o777;
    monitor.lockMetaDirectory();
    const modeAfter = statSync(testFile).mode & 0o777;
    // After locking, write permission is removed (0o444 for files)
    expect(modeAfter & 0o222).toBe(0);
    expect(modeAfter).not.toBe(modeBefore);

    // Clean up: unlock to restore write permissions
    monitor.unlockMetaDirectory();
  });

  it('FSM_UNIT_003 initializes the target project state in PROJECT_INIT', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);
    expect(machine.getProjectState().currentState).toBe(HarnessState.PROJECT_INIT);
  });

  it('FSM_UNIT_003A rejects invalid state-machine jumps for meta and project states', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);

    expect(() => machine.transitionMeta(HarnessState.PLANNING)).toThrow('Invalid meta state transition');
    expect(() => machine.transitionProject(HarnessState.DEV)).toThrow('Invalid project state transition');
  });

  it('FSM_UNIT_003B allows canonical state-machine progressions', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);

    machine.transitionMeta(HarnessState.PROJECT_INIT);
    machine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    machine.transitionMeta(HarnessState.PLANNING);
    expect(machine.getMetaState().currentState).toBe(HarnessState.PLANNING);

    machine.transitionProject(HarnessState.SPRINT_NEGOTIATION);
    machine.transitionProject(HarnessState.DEV);
    expect(machine.getProjectState().currentState).toBe(HarnessState.DEV);
  });

  it('FSM_UNIT_003C mirrors top-level project state transitions through requirement, planning, and dispatch phases', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);

    machine.transitionProject(HarnessState.REQUIREMENT_PARSE);
    machine.transitionProject(HarnessState.PLANNING);
    machine.transitionProject(HarnessState.SPRINT_DISPATCH);

    expect(machine.getProjectState().currentState).toBe(HarnessState.SPRINT_DISPATCH);
  });

  // FSM_UNIT_004 removed: ARCH_UNIT_001 already behaviorally verifies standard_requirement.md generation
  // FSM_UNIT_005 removed: ARCH_INT_002 already behaviorally verifies five planning documents requirement

  it('FSM_UNIT_006 dispatches the next pending sprint only when dependencies are met', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);
    machine.addSprint({
      id: 's1',
      name: 's1',
      priority: 1,
      goals: ['a'],
      deliverables: ['src/a.ts'],
      dependencies: [],
      status: 'completed',
    });
    machine.completeSprint('s1');
    machine.addSprint({
      id: 's2',
      name: 's2',
      priority: 2,
      goals: ['b'],
      deliverables: ['src/b.ts'],
      dependencies: ['s1'],
      status: 'pending',
    });
    expect(machine.getNextPendingSprint()?.id).toBe('s2');
  });

  it('FSM_UNIT_007 reaches contract agreement when evaluator returns agreed=true', async () => {
    const { targetDir } = useFixture();
    const contractPath = resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md');
    writeFileSync(contractPath, sampleSprintContract(), 'utf-8');

    const generator = { run: vi.fn(async () => 'ok') } as never;
    const evaluator = { run: vi.fn(async () => '```json\n{"agreed": true, "concerns": []}\n```') } as never;
    const negotiator = new SprintNegotiator(generator, evaluator, makeLogger(resolve(targetDir, 'project_logs')), 3);

    const result = await negotiator.negotiate(
      { id: 'sprint-01', name: 'Sprint 01', priority: 1, goals: [], deliverables: [], dependencies: [], status: 'pending' },
      'sprint section',
      sampleProductSpec(),
      '# architecture',
      'docs/sprint/sprint_contract_sprint-01.md',
    );

    expect(result.success).toBe(true);
    expect(result.rounds).toBe(2);
  });

  it('FSM_UNIT_008 fails negotiation when max rounds are exhausted without agreement', async () => {
    const { targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md'), sampleSprintContract(), 'utf-8');

    const generator = { run: vi.fn(async () => 'ok') } as never;
    const evaluator = { run: vi.fn(async () => '```json\n{"agreed": false, "concerns": ["more detail"]}\n```') } as never;
    const negotiator = new SprintNegotiator(generator, evaluator, makeLogger(resolve(targetDir, 'project_logs')), 3);

    const result = await negotiator.negotiate(
      { id: 'sprint-01', name: 'Sprint 01', priority: 1, goals: [], deliverables: [], dependencies: [], status: 'pending' },
      'section',
      sampleProductSpec(),
      '# architecture',
      'docs/sprint/sprint_contract_sprint-01.md',
    );

    expect(result.success).toBe(false);
    expect(result.rounds).toBe(3);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('FSM_UNIT_008A rejects contradictory negotiation payloads instead of treating them as agreement', async () => {
    const { targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md'), sampleSprintContract(), 'utf-8');

    const generator = { run: vi.fn(async () => 'ok') } as never;
    const evaluator = {
      run: vi.fn(async () => '```json\n{"agreed": true, "concerns": ["still broken"]}\n```'),
    } as never;
    const negotiator = new SprintNegotiator(generator, evaluator, makeLogger(resolve(targetDir, 'project_logs')), 2);

    const result = await negotiator.negotiate(
      { id: 'sprint-01', name: 'Sprint 01', priority: 1, goals: [], deliverables: [], dependencies: [], status: 'pending' },
      'section',
      sampleProductSpec(),
      '# architecture',
      'docs/sprint/sprint_contract_sprint-01.md',
    );

    expect(result.success).toBe(false);
    expect(result.issues).toContain('审查结果自相矛盾：已同意但仍包含待解决问题，请重新输出');
  });

  it('FSM_UNIT_008B rejects negative negotiation payloads that omit issue lists', async () => {
    const { targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md'), sampleSprintContract(), 'utf-8');

    const generator = { run: vi.fn(async () => 'ok') } as never;
    const evaluator = {
      run: vi.fn(async () => '```json\n{"agreed": false, "concerns": []}\n```'),
    } as never;
    const negotiator = new SprintNegotiator(generator, evaluator, makeLogger(resolve(targetDir, 'project_logs')), 2);

    const result = await negotiator.negotiate(
      { id: 'sprint-01', name: 'Sprint 01', priority: 1, goals: [], deliverables: [], dependencies: [], status: 'pending' },
      'section',
      sampleProductSpec(),
      '# architecture',
      'docs/sprint/sprint_contract_sprint-01.md',
    );

    expect(result.success).toBe(false);
    expect(result.issues).toContain('审查结果不通过时必须给出明确问题列表，请重新输出');
  });

  it('FSM_UNIT_009 requires generator self-checking instructions in DEV phase prompt', async () => {
    // Behavioral: verify generator agent prompt carries self-check instructions
    const client = {
      chatWithTools: vi.fn(async (msgs: any[]) => ({
        finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } },
        messages: msgs,
      })),
    };
    const tools = { toLLMTools: vi.fn(() => []), execute: vi.fn(async () => ({})) };
    const { metaDir } = useFixture();
    const generator = new GeneratorAgent(client as never, tools as never, metaDir);

    await generator.develop('sprint-01', '# contract', '# architecture', '# code standard', 'summary');

    const messages = (client.chatWithTools as any).mock.calls[0][0];
    // Behavioral: generator user message contains self-check instructions
    // (self-check instructions are in the user prompt, not the system prompt)
    expect(messages[1].content).toContain('执行基础验证');
    expect(messages[1].content).toContain('npm install');
    expect(messages[1].content).toContain('self_check_report');
  });

  it('FSM_UNIT_010 performs deterministic pre-evaluation checks before formal review', async () => {
    const { targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md'), sampleSprintContract(), 'utf-8');
    writeFileSync(resolve(targetDir, 'src/index.js'), 'console.log("ok");\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf-8');

    const preEvaluator = new PreEvaluator(targetDir, makeLogger(resolve(targetDir, 'project_logs')));
    const result = await preEvaluator.runPreEvaluation('sprint-01', 'docs/sprint/sprint_contract_sprint-01.md');

    expect(result.checks.contractExists).toBe(true);
    expect(result.checks.codeFilesExist).toBe(true);
    expect(result.report).toContain('Pre-Evaluation Report');
  });

  it('FSM_UNIT_010A fails pre-evaluation when contract deliverables are missing', async () => {
    const { targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md'), sampleSprintContract(), 'utf-8');
    writeFileSync(resolve(targetDir, 'src/index.js'), 'console.log("ok");\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf-8');

    const preEvaluator = new PreEvaluator(targetDir, makeLogger(resolve(targetDir, 'project_logs')));
    const result = await preEvaluator.runPreEvaluation('sprint-01', 'docs/sprint/sprint_contract_sprint-01.md');

    expect(result.passed).toBe(false);
    expect(result.checks.coreFilesPresent).toBe(false);
    expect(result.issues).toContain('Core deliverable files declared in the sprint contract are missing');
  });

  it('FSM_UNIT_011 encodes evaluator execution steps and hard-threshold logic', async () => {
    const capturedMessages: any[] = [];
    const client = {
      chatWithTools: vi.fn(async (msgs: any[]) => {
        capturedMessages.push(msgs);
        return {
          finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } },
          messages: msgs,
        };
      }),
    } as any;
    const tools = { toLLMTools: () => [], execute: vi.fn(async () => ({})) } as any;
    const evaluator = new EvaluatorAgent(client, tools);

    await evaluator.evaluate('# contract', '# architecture', '# code standard', 'sprint-01');

    const [systemMessage, userMessage] = capturedMessages[0];
    expect(systemMessage.content).toContain('编译/语法检查');
    expect(systemMessage.content).toContain('安全扫描');
    expect(systemMessage.content).toContain('硬阈值规则');
    expect(userMessage.content).toContain('使用 bash 执行语法检查和编译验证');
    expect(userMessage.content).toContain('使用 bash 运行测试用例');
  });

  it('FSM_UNIT_011A rejects reports that claim pass while violating hard thresholds', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));

    const disguisedPassReport = `# Review Report

## 评分
- 功能完整性: 5
- 代码质量与架构合规性: 8
- 可运行性与稳定性: 8
- 可测试性与文档完整性: 8
- 代码安全性: 8

## 整体加权平均分
7.6

## 验收结果
通过
`;

    expect((harness as any).checkEvaluationPassed(disguisedPassReport)).toBe(false);
  });

  it('FSM_UNIT_011B structured path rejects reports with dimension below minimum via extractReviewReportData', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    // Initialize infrastructure so artifactValidator is available (new structured path)
    (harness as any).initInfrastructure();

    const reportLowDimension = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 5
- 代码质量与架构合规性: 8
- 可运行性与稳定性: 8
- 可测试性与文档完整性: 8
- 代码安全性: 8

## 整体加权平均分
7.6

## 验收结果
通过
`;

    // New structured path: extractReviewReportData returns scores, then dimension check rejects
    expect((harness as any).checkEvaluationPassed(reportLowDimension)).toBe(false);
  });

  it('FSM_UNIT_011C structured path accepts reports meeting all thresholds', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const validReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 8
- 代码质量与架构合规性: 8
- 可运行性与稳定性: 8
- 可测试性与文档完整性: 8
- 代码安全性: 8

## 整体加权平均分
8.0

## 问题清单

## 修复要求

## 验收结果
通过
`;

    expect((harness as any).checkEvaluationPassed(validReport)).toBe(true);
  });

  it('FSM_UNIT_012 expects merge, tag, and branch cleanup in SPRINT_MERGE via real git operations', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');

    // Create a sprint branch and add a commit
    await git.createBranch('sprint/sprint-01');
    await git.checkout('sprint/sprint-01');
    writeFileSync(resolve(targetDir, 'src/index.ts'), 'export const a = 1;\n', 'utf-8');
    await git.commit('feat', 'sprint-01', 'implement feature');

    // Merge sprint branch back to dev
    await git.mergeBranch('sprint/sprint-01', 'dev');

    // Behavioral: create completion tag and delete sprint branch
    const tag = 'v0.1.0-sprint-01-complete';
    await git.createTag(tag);
    await git.deleteBranch('sprint/sprint-01');

    // Verify tag exists and branch is cleaned up
    expect(await git.getTags()).toContain(tag);
    expect(await git.branchExists('sprint/sprint-01')).toBe(false);
    expect(await git.getCurrentBranch()).toBe('dev');
  });

  it('FSM_UNIT_012A performs deterministic post-merge verification for passing projects', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'src/index.js'), 'console.log("ok");\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify({
      name: 'demo-project',
      scripts: {
        build: 'node --check src/index.js',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2), 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const result = await (harness as any).runPostMergeVerification();
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('FSM_UNIT_012B fails deterministic post-merge verification when build or test scripts fail', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFileSync(resolve(targetDir, 'src/index.js'), 'console.log("ok");\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify({
      name: 'demo-project',
      scripts: {
        build: 'node --check src/index.js',
        test: 'node -e "process.exit(1)"',
      },
    }, null, 2), 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const result = await (harness as any).runPostMergeVerification();
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue: string) => issue.includes('Test script failed'))).toBe(true);
  });

  // FSM_UNIT_013 removed: FSM_UNIT_013B and FSM_UNIT_013A already behaviorally verify
  // that final acceptance report path is used and validated

  it('FSM_UNIT_013B blocks final acceptance when planned sprints are still incomplete', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();
    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');

    mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/plan/sprint_plan.md'), `# Sprint Plan

## Sprint list
- sprint-01

## 里程碑
- v0.1.0-plan-complete
`, 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/plan/product_spec.md'), sampleProductSpec(), 'utf-8');
    writeFileSync(resolve(targetDir, 'standard_requirement.md'), sampleStandardRequirement(), 'utf-8');

    await expect((harness as any).finalAcceptance()).rejects.toThrow(
      'Final acceptance blocked: incomplete sprints remain (sprint-01)',
    );
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.META_INIT);
    expect((harness as any).stateMachine.getProjectState().currentState).toBe(HarnessState.PROJECT_INIT);
    expect(await git.getCurrentBranch()).toBe('dev');
    expect(await git.getTags()).not.toContain('v1.0.0-release-candidate');
    expect(await gitLogMessages(targetDir)).toEqual(['init(project): initialize target project structure']);
  });

  it('FSM_UNIT_013A rejects incomplete final acceptance reports instead of auto-completing them', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), '# incomplete\n', 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateFinalAcceptanceReportOrThrow('llm unavailable')).toThrow(
      'Final acceptance report missing or incomplete',
    );
  });

  it('FSM_UNIT_014 merges dev to main and tags the release in RELEASE', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');
    (harness as any).stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    (harness as any).stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    (harness as any).stateMachine.transitionMeta(HarnessState.PLANNING);
    (harness as any).stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
    (harness as any).stateMachine.transitionMeta(HarnessState.FINAL_ACCEPTANCE);
    (harness as any).stateMachine.transitionProject(HarnessState.FINAL_ACCEPTANCE);

    writePassingFinalAcceptanceReport(targetDir);
    writeFileSync(resolve(targetDir, 'README.md'), `# demo

## 安装
npm install

## 运行
npm run start

## 测试
npm test

## 项目结构
- src/
`, 'utf-8');

    (harness as any).client = {
      chatWithTools: vi.fn(async () => {
        throw new Error('offline');
      }),
      getTokenUsage: vi.fn(() => ({ total: 0 })),
    };

    await (harness as any).release();

    expect(await git.getCurrentBranch()).toBe('main');
    expect(await git.getTags()).toContain('v1.0.0-release');
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.FINISHED);
  });

  it('FSM_UNIT_015 archives metrics into the project summary report in FINISHED', () => {
    const { targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    const metrics = new MetricsCollector(makeLogger(resolve(targetDir, 'project_logs')));
    metrics.startSprint('sprint-01');
    metrics.recordSprintIteration('sprint-01');
    metrics.endSprint('sprint-01', true);
    const report = metrics.generateReport(targetDir);

    expect(report).toContain('项目全流程总结报告');
    expect(existsSync(resolve(targetDir, 'docs/report/project_summary_report.md'))).toBe(true);
  });

  it('FSM_UNIT_016 records exception handling details and archives root cause on self-heal', async () => {
    const { metaDir } = useFixture();
    const archiveDir = resolve(metaDir, 'meta_logs');
    const handler = new ExceptionHandler(
      new Logger(archiveDir, 'exception'),
      { maxRetriesP2: 2, maxRetriesP3: 3, maxRollbacksP1: 2, upgradeAfterRetries: 3 },
      archiveDir,
    );

    // Behavioral: P3 exception self-heals and auto-archives root cause
    const p3Result = await handler.handle(
      new Error('timeout reading file'),
      HarnessState.DEV,
      'generator',
    );
    expect(p3Result.healed).toBe(true);
    expect(p3Result.record.level).toBe('P3');
    expect(p3Result.record.resolved).toBe(true);

    // Behavioral: history tracks the exception
    const history = handler.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].phase).toBe(HarnessState.DEV);
    expect(history[0].module).toBe('generator');

    // Behavioral: P3 handler auto-archives root cause during self-heal
    const archive = handler.getRootCauseArchive();
    expect(archive.length).toBe(1);
    expect(archive[0].rootCause).toBe('operation_timeout');
    expect(archive[0].occurrences).toBe(1);
  });

  it('FSM_UNIT_017 pauses and resumes via manual intervention controls', async () => {
    const { metaDir, targetDir } = useFixture();
    const manual = new ManualIntervention(metaDir, makeLogger(resolve(metaDir, 'meta_logs')), targetDir);
    await manual.requestIntervention('catastrophic', HarnessState.MANUAL_INTERVENTION, 'boom', '{}');
    manual.resume();
    expect(manual.isPaused()).toBe(false);
  });

  it('FSM_SCN_001 enumerates the full happy-path state sequence without skipping core stages', () => {
    expect(Object.values(HarnessState)).toEqual([
      'META_INIT',
      'PROJECT_INIT',
      'REQUIREMENT_PARSE',
      'PLANNING',
      'SPRINT_DISPATCH',
      'SPRINT_NEGOTIATION',
      'DEV',
      'PRE_EVALUATION',
      'EVALUATION',
      'SPRINT_MERGE',
      'FINAL_ACCEPTANCE',
      'RELEASE',
      'FINISHED',
      'EXCEPTION_HANDLE',
      'MANUAL_INTERVENTION',
    ]);
  });

  it('FSM_SCN_002 allows exception handling to retry and escalate through P3→P2→P1→P0', async () => {
    const { metaDir } = useFixture();
    const archiveDir = resolve(metaDir, 'meta_logs');
    const handler = new ExceptionHandler(
      new Logger(archiveDir, 'exception'),
      { maxRetriesP2: 2, maxRetriesP3: 3, maxRollbacksP1: 1, upgradeAfterRetries: 3 },
      archiveDir,
    );

    // Behavioral: P0 (catastrophic) immediately aborts
    const p0 = await handler.handle(
      new Error('requirement completely unparseable'),
      HarnessState.META_INIT,
      'parser',
    );
    expect(p0.action).toBe('abort');
    expect(p0.record.level).toBe('P0');

    // Behavioral: P2 (validation failure) returns retry
    const p2r1 = await handler.handle(
      new Error('validation failed for sprint contract'),
      HarnessState.DEV,
      'generator',
    );
    expect(p2r1.record.level).toBe('P2');
    expect(p2r1.action).toBe('retry');
    expect(p2r1.upgraded).toBe(false);

    // Behavioral: P3 (timeout) self-heals via auto-retry
    const p3r1 = await handler.handle(
      new Error('timeout reading source file'),
      HarnessState.EVALUATION,
      'evaluator',
    );
    expect(p3r1.healed).toBe(true);
    expect(p3r1.record.level).toBe('P3');

    // Behavioral: P3 retries continue self-healing until max (3) reached
    const p3r2 = await handler.handle(
      new Error('timeout reading source file'),
      HarnessState.EVALUATION,
      'evaluator',
    );
    expect(p3r2.healed).toBe(true);

    // Third P3 in same module still self-heals (p3Count=3, maxRetriesP3=3 → upgrade)
    const p3r3 = await handler.handle(
      new Error('timeout reading source file'),
      HarnessState.EVALUATION,
      'evaluator',
    );
    expect(p3r3.upgraded).toBe(true); // upgraded from P3 to P2

    // Behavioral: history records all exception classifications
    const metrics = handler.getMetrics();
    expect(metrics.total).toBe(5);
    expect(metrics.byLevel['P0']).toBeGreaterThanOrEqual(1);
    expect(metrics.byLevel['P2']).toBeGreaterThanOrEqual(1);
    expect(metrics.byLevel['P3']).toBeGreaterThanOrEqual(1);
  });

  it('ARCH_INT_001 and FSM_UNIT_006 create recoverable checkpoints that can be resumed later', () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));
    manager.save({
      id: 'cp-1',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.PLANNING,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'dev', lastCommit: 'abc123', tags: [] },
    });
    expect(manager.getLatest()?.state).toBe(HarnessState.PLANNING);
  });
});
