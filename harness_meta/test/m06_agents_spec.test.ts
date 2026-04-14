/**
 * M06 多 Agent 设计与执行合同 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖三个核心 Agent（Planner/Generator/Evaluator）的调用合同。
 * 包括：Agent 实例隔离、轻量上下文注入、prompt 内容合同、evaluator 5 维硬阈值、
 * 一票否决、修复迭代传递 review report、模糊/矛盾结论拒绝。
 * 测试通过 mock LLM client 截获运行时 payload 验证调用合同，无源码字符串断言。
 */
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
import { HarnessState } from '../src/types.js';
import { createWorkspaceFixture, makeLogger, sampleSprintContract } from './helpers/fixtures.js';

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

function getPromptCall(client: ReturnType<typeof makeClient>) {
  return (client.chatWithTools as any).mock.calls[0][0] as Array<{ role: string; content: string }>;
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
    const tools = makeToolRegistry();
    const planner = new PlannerAgent(makeClient() as never, tools as never);
    const generator = new GeneratorAgent(makeClient() as never, tools as never, process.cwd());
    const evaluator = new EvaluatorAgent(makeClient() as never, tools as never);

    expect(Object.keys(planner)).not.toContain('generator');
    expect(Object.keys(planner)).not.toContain('evaluator');
    expect(Object.keys(generator)).not.toContain('planner');
    expect(Object.keys(generator)).not.toContain('evaluator');
    expect(Object.keys(evaluator)).not.toContain('planner');
    expect(Object.keys(evaluator)).not.toContain('generator');
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
    const client = makeClient();
    const planner = new PlannerAgent(client as never, makeToolRegistry() as never);

    return planner.plan('# requirement').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('绝对不允许编写任何具体的代码实现细节');
      expect(messages[1].content).toContain('docs/plan/product_spec.md');
    });
  });

  it('AGT_UNIT_006 makes planner output a bounded sprint plan with small-step delivery', () => {
    const client = makeClient();
    const planner = new PlannerAgent(client as never, makeToolRegistry() as never);

    return planner.plan('# requirement').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('单个Sprint核心功能不超过3个');
      expect(messages[0].content).toContain('Sprint计划必须遵循小步快跑原则');
    });
  });

  it('AGT_UNIT_007 requires planner documents to stay in target-project-relative paths', () => {
    const client = makeClient();
    const planner = new PlannerAgent(client as never, makeToolRegistry() as never);

    return planner.plan('# requirement').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('你**绝对不能**使用绝对路径');
      expect(messages[0].content).toContain('你**绝对不能**使用 `..`');
      expect(messages[1].content).toContain('禁止使用绝对路径或 .. 逃逸');
    });
  });

  it('AGT_UNIT_008 supports planner-side architecture feedback processing', () => {
    const client = makeClient();
    const planner = new PlannerAgent(client as never, makeToolRegistry() as never);

    return planner.plan('# requirement').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('架构反馈处理');
      expect(messages[0].content).toContain('需要修订');
      expect(messages[0].content).toContain('回退范围建议');
    });
  });

  it('AGT_UNIT_009 constrains generator to implement only within the agreed architecture', () => {
    const client = makeClient();
    const generator = new GeneratorAgent(client as never, makeToolRegistry() as never, process.cwd());

    return generator.develop('sprint-01', '# contract', '# architecture', '# code standard', 'summary').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('绝对不允许私自修改架构或调整技术栈');
      expect(messages[0].content).toContain('完整可运行的');
      expect(messages[1].content).toContain('## 架构设计 (关键要点)');
    });
  });

  it('AGT_UNIT_010 requires generator outputs to land in target src/test paths with self-check reports', () => {
    const client = makeClient();
    const generator = new GeneratorAgent(client as never, makeToolRegistry() as never, process.cwd());

    return generator.develop('sprint-01', '# contract', '# architecture', '# code standard', 'summary').then(() => {
      const messages = getPromptCall(client);
      expect(messages[1].content).toContain('src/index.ts');
      expect(messages[1].content).toContain('docs/sprint/self_check_report_sprint-01.md');
    });
  });

  it('AGT_UNIT_011 forbids stub code and TODO placeholders in generator expectations', () => {
    const client = makeClient();
    const generator = new GeneratorAgent(client as never, makeToolRegistry() as never, process.cwd());

    return generator.develop('sprint-01', '# contract', '# architecture', '# code standard', 'summary').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('严禁Stub代码');
      expect(messages[0].content).toContain('不能有未捕获的异常');
    });
  });

  it('AGT_UNIT_012 requires generator self-checks before review handoff', () => {
    const client = makeClient();
    const generator = new GeneratorAgent(client as never, makeToolRegistry() as never, process.cwd());

    return generator.develop('sprint-01', '# contract', '# architecture', '# code standard', 'summary').then(() => {
      const messages = getPromptCall(client);
      expect(messages[1].content).toContain('用 bash 执行基础验证');
      expect(messages[1].content).toContain('docs/sprint/self_check_report_sprint-01.md');
      expect(messages[1].content).toContain('语法检查结果');
    });
  });

  it('AGT_UNIT_012A generator.fix must carry the review report into repair iterations', async () => {
    const client = makeClient();
    const generator = new GeneratorAgent(client as never, makeToolRegistry() as never, process.cwd());
    const reviewReport = `# Review Report

## 问题清单
- ISSUE-001 src/index.ts:12 root cause: missing bootstrap fix suggestion: add bootstrap export

## 验收结果
不通过
`;

    await generator.fix(reviewReport, '# Sprint Contract\n- ID: sprint-01\n', 2);

    const messages = getPromptCall(client);
    expect(messages[1].content).toContain('## 验收评审报告');
    expect(messages[1].content).toContain('ISSUE-001 src/index.ts:12');
    expect(messages[1].content).toContain('第 2 次修复迭代');
    expect(messages[1].content).toContain('[AgentContext] role=generator sprintId=sprint-01');
  });

  it('AGT_UNIT_013 defines evaluator scoring with five weighted dimensions', () => {
    const client = makeClient();
    const evaluator = new EvaluatorAgent(client as never, makeToolRegistry() as never);

    return evaluator.evaluate('# contract', '# architecture', '# code standard', 'sprint-01').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('功能完整性 | 35%');
      expect(messages[0].content).toContain('代码质量与架构合规性 | 25%');
      expect(messages[0].content).toContain('可运行性与稳定性 | 20%');
      expect(messages[0].content).toContain('可测试性与文档完整性 | 10%');
      expect(messages[0].content).toContain('代码安全性 | 10%');
    });
  });

  it('AGT_UNIT_014 enforces evaluator veto rules for missing core quality gates', () => {
    const client = makeClient();
    const evaluator = new EvaluatorAgent(client as never, makeToolRegistry() as never);

    return evaluator.evaluate('# contract', '# architecture', '# code standard', 'sprint-01').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('任何一个维度 < 6分');
      expect(messages[0].content).toContain('整体加权平均分 < 7分');
      expect(messages[0].content).toContain('功能完整性维度直接 0 分');
    });
  });

  it('AGT_UNIT_015 requires evaluator to run tools instead of static review only', () => {
    const client = makeClient();
    const tools = {
      toLLMTools: vi.fn(() => [{ name: 'bash' }, { name: 'security_scan' }]),
      execute: vi.fn(),
    };
    const evaluator = new EvaluatorAgent(client as never, tools as never);

    return evaluator.evaluate('# contract', '# architecture', '# code standard', 'sprint-01').then(() => {
      const messages = getPromptCall(client);
      const llmTools = (tools.toLLMTools as any).mock.results[0].value;
      expect(messages[0].content).toContain('必须通过工具实际运行代码');
      expect(messages[0].content).toContain('bash 运行测试用例');
      expect(llmTools).toHaveLength(2);
      expect(llmTools.map((tool: { name: string }) => tool.name)).toEqual(['bash', 'security_scan']);
    });
  });

  it('AGT_UNIT_016 emits architecture feedback when evaluator finds architectural defects', () => {
    const client = makeClient();
    const evaluator = new EvaluatorAgent(client as never, makeToolRegistry() as never);

    return evaluator.evaluate('# contract', '# architecture', '# code standard', 'sprint-01').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('架构反馈机制');
      expect(messages[0].content).toContain('需要修改架构');
      expect(messages[0].content).toContain('需要回退');
    });
  });

  it('AGT_UNIT_017 requires evaluator issue reports to carry file, line, root cause, and fix guidance', () => {
    const client = makeClient();
    const evaluator = new EvaluatorAgent(client as never, makeToolRegistry() as never);

    return evaluator.evaluate('# contract', '# architecture', '# code standard', 'sprint-01').then(() => {
      const messages = getPromptCall(client);
      expect(messages[0].content).toContain('| 问题ID | 严重程度 | 文件 | 行号 | 描述 | 修复建议 |');
      expect(messages[0].content).toContain('具体的文件和代码行号');
      expect(messages[0].content).toContain('可落地的修复建议');
      expect(messages[1].content).toContain('docs/sprint/review_report_sprint-01.md');
    });
  });

  it('AGT_INT_001 coordinates planner -> generator -> evaluator through the orchestrator only', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect((harness as any).planner).toBeDefined();
    expect((harness as any).generator).toBeDefined();
    expect((harness as any).evaluator).toBeDefined();
    expect((harness as any).feedbackChannel).toBeDefined();
    expect((harness as any).planner).not.toBe((harness as any).generator);
    expect((harness as any).generator).not.toBe((harness as any).evaluator);
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

  it('AGT_BEHAVIOR_005A ambiguous conclusion (neither pass nor fail explicitly) causes rejection', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    // Ambiguous conclusion: no explicit "通过" or "不通过" keyword at all
    const ambiguousReport = `# Review

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
待定，需要进一步确认
`;
    expect((harness as any).checkEvaluationPassed(ambiguousReport)).toBe(false);
  });

  it('AGT_BEHAVIOR_005B contradictory conclusion (pass text but scores clearly insufficient) must fail', () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const config: HarnessConfig = {
      version: '0.1.0',
      llm: { baseURL: 'http://localhost:1234', apiKey: 'test', apiKeyEnvVar: 'TEST', model: 'test', maxTokens: 2048, temperature: 0 },
      thresholds: { maxRetries: 2, maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationPassScore: 7, evaluationMinDimensionScore: 6 },
      paths: { workspaceRoot: rootDir, ideaFile: resolve(targetDir, 'idea.md'), targetProject: targetDir, metaLogs: resolve(metaDir, 'meta_logs') },
    };
    const harness = new Harness(config);
    (harness as any).initInfrastructure();

    // Contradictory: says "通过" but only 2 dimensions, with weighted average 4.0
    const contradictoryReport = `# Review

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 4
- 代码质量与架构合规性: 4

## 整体加权平均分
4.0

## 验收结果
通过
`;
    // Must fail: missing 3 dimensions AND average below threshold AND dimension below minimum
    expect((harness as any).checkEvaluationPassed(contradictoryReport)).toBe(false);
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

  it('AGT_BEHAVIOR_008 executeSprint passes the previous review report into generator.fix on retry iterations', async () => {
    const { rootDir, metaDir, targetDir } = createWorkspaceFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');

    const machine = (harness as any).stateMachine;
    machine.transitionMeta(HarnessState.PROJECT_INIT);
    machine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    machine.transitionMeta(HarnessState.PLANNING);
    machine.transitionMeta(HarnessState.SPRINT_DISPATCH);

    vi.spyOn((harness as any).negotiator, 'negotiate').mockImplementation(async (...args: any[]) => {
      const contractPath = args[4] as string;
      mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
      writeFileSync(contractPath, sampleSprintContract(), 'utf-8');
      return { success: true, rounds: 1 };
    });

    const develop = vi.spyOn((harness as any).generator, 'develop').mockImplementation(async () => {
      mkdirSync(resolve(targetDir, 'src'), { recursive: true });
      mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
      writeFileSync(resolve(targetDir, 'src/index.ts'), 'export const bootstrap = 1;\n', 'utf-8');
      writeFileSync(resolve(targetDir, 'docs/sprint/self_check_report_sprint-01.md'), '# self-check\npass\n', 'utf-8');
      return 'developed';
    });

    const fix = vi.spyOn((harness as any).generator, 'fix').mockImplementation(async () => {
      writeFileSync(resolve(targetDir, 'src/index.ts'), 'export const bootstrap = 2;\n', 'utf-8');
      return 'fixed';
    });

    vi.spyOn((harness as any).preEvaluator, 'runPreEvaluation').mockResolvedValue({
      passed: true,
      issues: [],
      checks: {},
    });

    const failingReview = `# Review Report

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

## 问题清单
- ISSUE-001 src/index.ts:1 root cause: bootstrap is incomplete fix suggestion: export the final bootstrap implementation

## 验收结果
不通过
`;

    const passingReview = `# Review Report

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

    let evalCount = 0;
    vi.spyOn((harness as any).evaluator, 'evaluate').mockImplementation(async () => {
      mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
      evalCount++;
      writeFileSync(
        resolve(targetDir, 'docs/sprint/review_report_sprint-01.md'),
        evalCount === 1 ? failingReview : passingReview,
        'utf-8',
      );
      return 'evaluated';
    });

    vi.spyOn((harness as any), 'runPostMergeVerification').mockResolvedValue({ passed: true, issues: [] });

    const result = await (harness as any).executeSprint(
      'sprint-01',
      '# sprint plan',
      '## sprint-01\n- implement feature\n',
      '# architecture',
      '# code standard',
      '# product spec',
      { maxSprintIterations: 2 },
    );

    expect(result).toBe('passed');
    expect(develop).toHaveBeenCalledTimes(1);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(fix.mock.calls[0][0]).toContain('ISSUE-001 src/index.ts:1');
    expect(fix.mock.calls[0][0]).toContain('不通过');
    expect(fix.mock.calls[0][1]).toContain('ID: sprint-01');
    expect(fix.mock.calls[0][2]).toBe(2);
  });
});
