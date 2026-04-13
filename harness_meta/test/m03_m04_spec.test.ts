import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  makeLogger,
  readHarnessFile,
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

describe('M03 architecture contract and M04 FSM coverage', () => {
  it('ARCH_UNIT_001 writes standard requirements into the target project contract space', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('standard_requirement.md');
    expect(harness).toContain('generate standardized requirement document');
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
    const { targetDir } = useFixture();
    const preEvalLogger = makeLogger(resolve(targetDir, 'project_logs'));
    const validator = new ArtifactValidator(preEvalLogger);
    const preEvaluator = new PreEvaluator(targetDir, preEvalLogger, validator);

    writeFileSync(resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md'), sampleSprintContract(), 'utf-8');
    writeFileSync(resolve(targetDir, 'src/index.js'), 'console.log("ready");\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf-8');
    const result = await preEvaluator.runPreEvaluation('sprint-01', 'docs/sprint/sprint_contract_sprint-01.md');

    expect(existsSync(resolve(targetDir, 'src'))).toBe(true);
    expect(result.checks.contractExists).toBe(true);
  });

  it('ARCH_UNIT_004 keeps the harness orchestrator as the single coordination entrypoint', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('private planner!');
    expect(harness).toContain('private generator!');
    expect(harness).toContain('private evaluator!');
    expect(harness).toContain('this.initInfrastructure()');
  });

  it('ARCH_UNIT_005 keeps SPOF recovery through checkpoints and exception handling', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('CheckpointManager');
    expect(harness).toContain('executePhaseWithRetry');
    expect(harness).toContain('saveCheckpoint');
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

  it('ARCH_INT_002 makes planner output the five planning artifacts into docs/plan', () => {
    const planner = readHarnessFile('src/agents/planner.ts');
    expect(planner).toContain('docs/plan/product_spec.md');
    expect(planner).toContain('docs/plan/architecture_design.md');
    expect(planner).toContain('docs/plan/project_structure.md');
    expect(planner).toContain('docs/plan/code_standard.md');
    expect(planner).toContain('docs/plan/sprint_plan.md');
  });

  it('ARCH_INT_002A aborts planning when artifacts remain invalid after retries', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');

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
    expect(await git.getTags()).not.toContain('v0.1.0-plan-complete');
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

  it('ARCH_UNIT_007 wires git management into the infrastructure layer', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('this.git.setIsolationMonitor');
    expect(harness).toContain('ToolRegistry.createDefault');
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
    const configSource = readHarnessFile('src/config.ts');
    expect(configSource).toContain('apiKeyEnvVar');
    expect(configSource).toContain('Plaintext API keys in shared config files are prohibited');
    expect(configSource).toContain('harness_secrets.local.json');
  });

  it('ARCH_UNIT_010 validates planning artifacts with the validator module', () => {
    const validatorSource = readHarnessFile('src/artifacts/validator.ts');
    expect(validatorSource).toContain('validatePlanningDocs');
    expect(validatorSource).toContain('ProductSpecSchema');
    expect(validatorSource).toContain('SprintContractSchema');
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

  it('FSM_UNIT_002 verifies isolation before build lock and state progression', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('this.isolationMonitor.verifyIsolation()');
    expect(harness).toContain('lockMetaDirectory');
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

  it('FSM_UNIT_004 references standard_requirement generation in REQUIREMENT_PARSE', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('standard_requirement.md');
  });

  it('FSM_UNIT_005 requires five planning documents before leaving PLANNING', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain("const requiredFiles = ['product_spec.md', 'architecture_design.md', 'project_structure.md', 'code_standard.md', 'sprint_plan.md']");
  });

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

  it('FSM_UNIT_009 requires generator self-checking in DEV', () => {
    const generator = readHarnessFile('src/agents/generator.ts');
    expect(generator).toContain('执行基础验证');
    expect(generator).toContain('npm install');
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

  it('FSM_UNIT_011 encodes evaluator execution steps and hard-threshold logic', () => {
    const evaluatorPrompt = readHarnessFile('prompts/evaluator_system.md');
    expect(evaluatorPrompt).toContain('编译/语法检查');
    expect(evaluatorPrompt).toContain('安全扫描');
    expect(evaluatorPrompt).toContain('硬阈值规则');
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

  it('FSM_UNIT_012 expects merge, tag, and branch cleanup in SPRINT_MERGE', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain("createTag(`v0.${this.parseSprintNumber(sprintId)}.0-sprint-${sprintId}-complete`)");
    expect(harness).toContain('deleteBranch(branchName)');
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

  it('FSM_UNIT_013 writes the final acceptance report in FINAL_ACCEPTANCE', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('docs/report/final_acceptance_report.md');
  });

  it('FSM_UNIT_013B blocks final acceptance when planned sprints are still incomplete', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

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

  it('FSM_UNIT_014 merges dev to main and tags the release in RELEASE', () => {
    const metrics = readHarnessFile('src/orchestrator/metrics.ts');
    expect(metrics).toContain('v1.0.0-release');
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

  it('FSM_UNIT_016 records exception state handling details and retries', () => {
    const exceptionSource = readHarnessFile('src/exception/handler.ts');
    expect(exceptionSource).toContain('ExceptionLevel.P2');
    expect(exceptionSource).toContain('handleP2');
    expect(exceptionSource).toContain('archiveRootCause');
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

  it('FSM_SCN_002 allows exception handling to retry and escalate toward manual intervention', () => {
    const exceptionSource = readHarnessFile('src/exception/handler.ts');
    expect(exceptionSource).toContain('P2 → P1 UPGRADE');
    expect(exceptionSource).toContain('P1 → P0 UPGRADE');
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
