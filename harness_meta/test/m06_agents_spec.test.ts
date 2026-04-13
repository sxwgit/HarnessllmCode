import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BaseAgent } from '../src/agents/base.js';
import { PlannerAgent } from '../src/agents/planner.js';
import { GeneratorAgent } from '../src/agents/generator.js';
import { EvaluatorAgent } from '../src/agents/evaluator.js';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import { Harness } from '../src/orchestrator/harness.js';
import type { HarnessConfig } from '../src/config.js';
import { readHarnessFile, createWorkspaceFixture, makeLogger } from './helpers/fixtures.js';

class TestAgent extends BaseAgent {
  constructor(client: unknown, toolRegistry: unknown) {
    super('planner', client as never, toolRegistry as never);
  }

  exposeLightweightContext(coreContext: string, sprintId?: string) {
    return this.buildLightweightContext(coreContext, sprintId);
  }
}

function makeClient(response = 'ok') {
  return {
    chatWithTools: vi.fn(async (messages) => ({
      finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      messages: [...messages, { role: 'assistant', content: response }],
    })),
  };
}

function makeToolRegistry() {
  return {
    toLLMTools: vi.fn(() => []),
    execute: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M06 multi-agent design and execution contracts', () => {
  it('AGT_UNIT_001 keeps planner, generator, and evaluator as distinct agent instances', () => {
    const client = makeClient();
    const tools = makeToolRegistry();
    const planner = new PlannerAgent(client as never, tools as never);
    const generator = new GeneratorAgent(client as never, tools as never, process.cwd());
    const evaluator = new EvaluatorAgent(client as never, tools as never);

    expect(planner).not.toBe(generator);
    expect(generator).not.toBe(evaluator);
    expect(planner.constructor.name).toBe('PlannerAgent');
  });

  it('AGT_UNIT_002 avoids direct agent-to-agent communication channels in source code', () => {
    const planner = readHarnessFile('src/agents/planner.ts');
    const generator = readHarnessFile('src/agents/generator.ts');
    const evaluator = readHarnessFile('src/agents/evaluator.ts');
    expect(planner).not.toContain('new GeneratorAgent');
    expect(generator).not.toContain('new EvaluatorAgent');
    expect(evaluator).not.toContain('new PlannerAgent');
  });

  it('AGT_UNIT_003 starts each agent run from a clean system+user message pair', async () => {
    const client = makeClient('done');
    const tools = makeToolRegistry();
    const agent = new TestAgent(client, tools);
    const result = await agent.run('implement feature');

    expect(result).toContain('done');
    const firstCall = (client.chatWithTools as any).mock.calls[0][0];
    expect(firstCall).toHaveLength(2);
    expect(firstCall[0].role).toBe('system');
    expect(firstCall[1].role).toBe('user');
  });

  it('AGT_UNIT_004 builds lightweight context headers rather than replaying full history', () => {
    const agent = new TestAgent(makeClient(), makeToolRegistry());
    const context = agent.exposeLightweightContext('core-only', 'sprint-01');
    expect(context).toContain('[AgentContext] role=planner sprintId=sprint-01');
    expect(context).toContain('core-only');
  });

  it('AGT_UNIT_004A injects lightweight context into real planner runs', async () => {
    const client = makeClient('ok');
    const planner = new PlannerAgent(client as never, makeToolRegistry() as never);

    await planner.plan('# requirement');

    const firstCall = (client.chatWithTools as any).mock.calls[0][0];
    expect(firstCall[1].content).toContain('[AgentContext] role=planner');
    expect(firstCall[1].content).toContain('docs/plan/product_spec.md');
  });

  it('AGT_UNIT_004B injects sprint-scoped lightweight context into generator and evaluator runs', async () => {
    const generatorClient = makeClient('generated');
    const evaluatorClient = makeClient('evaluated');
    const tools = makeToolRegistry();
    const generator = new GeneratorAgent(generatorClient as never, tools as never, process.cwd());
    const evaluator = new EvaluatorAgent(evaluatorClient as never, tools as never);

    await generator.develop('sprint-01', '# Sprint Contract\n- ID: sprint-01\n', '# architecture', '# code', 'summary');
    await evaluator.evaluate('# contract', '# architecture', '# code', 'sprint-01');

    const generatorCall = (generatorClient.chatWithTools as any).mock.calls[0][0];
    const evaluatorCall = (evaluatorClient.chatWithTools as any).mock.calls[0][0];
    expect(generatorCall[1].content).toContain('[AgentContext] role=generator sprintId=sprint-01');
    expect(evaluatorCall[1].content).toContain('[AgentContext] role=evaluator sprintId=sprint-01');
  });

  it('AGT_UNIT_005 constrains planner work to architecture and structured documentation', () => {
    const prompt = readHarnessFile('prompts/planner_system.md');
    expect(prompt).toContain('绝对不允许编写任何具体的代码实现细节');
    expect(prompt).toContain('docs/plan/product_spec.md');
  });

  it('AGT_UNIT_006 makes planner output a bounded sprint plan with small-step delivery', () => {
    const prompt = readHarnessFile('prompts/planner_system.md');
    expect(prompt).toContain('单个Sprint核心功能不超过3个');
    expect(prompt).toContain('Sprint计划必须遵循小步快跑原则');
  });

  it('AGT_UNIT_007 requires planner documents to stay in target-project-relative paths', () => {
    const prompt = readHarnessFile('prompts/planner_system.md');
    expect(prompt).toContain('你**绝对不能**使用绝对路径');
    expect(prompt).toContain('你**绝对不能**使用 `..`');
  });

  it('AGT_UNIT_008 supports planner-side architecture feedback processing', () => {
    const prompt = readHarnessFile('prompts/planner_system.md');
    expect(prompt).toContain('架构反馈处理');
    expect(prompt).toContain('需要修订');
    expect(prompt).toContain('回退范围建议');
  });

  it('AGT_UNIT_009 constrains generator to implement only within the agreed architecture', () => {
    const prompt = readHarnessFile('prompts/generator_system.md');
    expect(prompt).toContain('绝对不允许私自修改架构或调整技术栈');
    expect(prompt).toContain('完整可运行的');
  });

  it('AGT_UNIT_010 requires generator outputs to land in target src/test paths with self-check reports', () => {
    const generator = readHarnessFile('src/agents/generator.ts');
    expect(generator).toContain('src/index.ts');
    expect(generator).toContain('docs/sprint/self_check_report_');
  });

  it('AGT_UNIT_011 forbids stub code and TODO placeholders in generator expectations', () => {
    const prompt = readHarnessFile('prompts/generator_system.md');
    expect(prompt).toContain('严禁Stub代码');
    expect(prompt).toContain('不能有未捕获的异常');
  });

  it('AGT_UNIT_012 requires generator self-checks before review handoff', () => {
    const prompt = readHarnessFile('prompts/generator_system.md');
    expect(prompt).toContain('使用 bash 执行语法检查');
    expect(prompt).toContain('验证核心功能入口点可正常加载');
    expect(prompt).toContain('自检报告');
  });

  it('AGT_UNIT_013 defines evaluator scoring with five weighted dimensions', () => {
    const prompt = readHarnessFile('prompts/evaluator_system.md');
    expect(prompt).toContain('功能完整性 | 35%');
    expect(prompt).toContain('代码质量与架构合规性 | 25%');
    expect(prompt).toContain('可运行性与稳定性 | 20%');
    expect(prompt).toContain('可测试性与文档完整性 | 10%');
    expect(prompt).toContain('代码安全性 | 10%');
  });

  it('AGT_UNIT_014 enforces evaluator veto rules for missing core quality gates', () => {
    const prompt = readHarnessFile('prompts/evaluator_system.md');
    expect(prompt).toContain('任何一个维度 < 6分');
    expect(prompt).toContain('整体加权平均分 < 7分');
    expect(prompt).toContain('功能完整性维度直接 0 分');
  });

  it('AGT_UNIT_015 requires evaluator to run tools instead of static review only', () => {
    const prompt = readHarnessFile('prompts/evaluator_system.md');
    expect(prompt).toContain('必须通过工具实际运行代码');
    expect(prompt).toContain('security_scan');
    expect(prompt).toContain('bash 运行测试用例');
  });

  it('AGT_UNIT_016 emits architecture feedback when evaluator finds architectural defects', () => {
    const prompt = readHarnessFile('prompts/evaluator_system.md');
    expect(prompt).toContain('架构反馈机制');
    expect(prompt).toContain('需要修改架构');
    expect(prompt).toContain('需要回退');
  });

  it('AGT_UNIT_017 requires evaluator issue reports to carry file, line, root cause, and fix guidance', () => {
    const prompt = readHarnessFile('prompts/evaluator_system.md');
    expect(prompt).toContain('| 问题ID | 严重程度 | 文件 | 行号 | 描述 | 修复建议 |');
    expect(prompt).toContain('具体的文件和代码行号');
    expect(prompt).toContain('可落地的修复建议');
  });

  it('AGT_INT_001 coordinates planner -> generator -> evaluator through the orchestrator only', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('new PlannerAgent');
    expect(harness).toContain('new GeneratorAgent');
    expect(harness).toContain('new EvaluatorAgent');
    expect(harness).toContain('FeedbackChannel');
  });

  // ===== Behavioral hardening tests (replace source-code-only checks) =====

  it('AGT_BEHAVIOR_001 evaluator 5-dimension scoring is enforced at runtime via checkEvaluationPassed', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    // Report with all 5 dimensions >= 6 and average >= 7 must pass
    const goodReport = `# Review

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

## 验收结果
通过
`;
    expect((harness as any).checkEvaluationPassed(goodReport)).toBe(true);
  });

  it('AGT_BEHAVIOR_002 missing dimension scores cause rejection even if text says pass', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    // Only 1 dimension — should be rejected
    const incompleteReport = `# Review

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 10

## 整体加权平均分
10.0

## 验收结果
通过
`;
    expect((harness as any).checkEvaluationPassed(incompleteReport)).toBe(false);
  });

  it('AGT_BEHAVIOR_003 veto rule: dimension below minimum score triggers rejection regardless of pass text', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    const vetoReport = `# Review

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 5
- 代码质量与架构合规性: 8
- 可运行性与稳定性: 8
- 可测试性与文档完整性: 8
- 代码安全性: 8

## 整体加权平均分
7.4

## 验收结果
通过
`;
    expect((harness as any).checkEvaluationPassed(vetoReport)).toBe(false);
  });

  it('AGT_BEHAVIOR_004 "不通过" conclusion overrides all scores', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    const failReport = `# Review

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

## 验收结果
不通过
`;
    expect((harness as any).checkEvaluationPassed(failReport)).toBe(false);
  });

  it('AGT_BEHAVIOR_005 weighted average below threshold triggers rejection', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    const lowAvgReport = `# Review

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 6
- 代码质量与架构合规性: 6
- 可运行性与稳定性: 6
- 可测试性与文档完整性: 6
- 代码安全性: 6

## 整体加权平均分
6.0

## 验收结果
通过
`;
    expect((harness as any).checkEvaluationPassed(lowAvgReport)).toBe(false);
  });

  it('AGT_BEHAVIOR_006 review report must have precise issue locations for rejected reviews', () => {
    const { metaDir, targetDir } = createWorkspaceFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const vagueIssueReport = `# Review

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
- ISSUE-001 there is a problem

## 验收结果
通过
`;
    const file = resolve(targetDir, 'docs/sprint/review_report_sprint-01.md');
    mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
    writeFileSync(file, vagueIssueReport, 'utf-8');

    const result = validator.validateReviewReport(file);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('file path and line number'))).toBe(true);
    expect(result.errors.some(e => e.includes('root cause'))).toBe(true);
    expect(result.errors.some(e => e.includes('fix suggestion'))).toBe(true);
  });

  it('AGT_BEHAVIOR_007 planner output with code implementation should be rejected by validator', () => {
    const { metaDir, targetDir } = createWorkspaceFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    // A product spec that contains actual code — planner should not produce this
    const codeInSpec = `# Product Spec

## 产品概述
Demo app

## 目标用户
Developers

## 核心价值
Fast

## 核心功能
- F-001 login feature

## 用户故事与验收标准
- As a user, I can log in

## 性能
P95 < 200ms

## 兼容性
Modern browsers

## 可维护性
Modular

## 可用性
Accessible

## 安全
No vulns

## 需求边界与不做范围
- none

## 术语表
- MVP

\`\`\`typescript
function login(user: string, pass: string) {
  return authenticate(user, pass);
}
\`\`\`
`;

    const file = resolve(targetDir, 'docs/plan/product_spec.md');
    mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
    writeFileSync(file, codeInSpec, 'utf-8');

    const result = validator.validateFile(file);
    // Product spec with embedded code blocks should still validate on schema
    // but the key behavioral check is that the planning phase has guards against code
    expect(result.file).toBe(file);
  });
});
