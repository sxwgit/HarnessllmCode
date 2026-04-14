/**
 * M09 产物模板 / M10 版本与合规 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖 ArtifactValidator 的 Zod schema 验证、空壳反作弊、
 * config 安全（明文 API key 拒绝）、framework version 不可变、安全命令阻断。
 * 验证方式：调用真实 ArtifactValidator 和 config 加载行为，无源码字符串断言。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import type { HarnessConfig } from '../src/config.js';
import { Harness } from '../src/orchestrator/harness.js';
import { GitManager } from '../src/git/manager.js';
import { ManualIntervention } from '../src/orchestrator/manual-intervention.js';
import { BashTool } from '../src/tools/bash.js';
import { MetricsCollector } from '../src/orchestrator/metrics.js';
import { Logger } from '../src/logger/index.js';
import { FRAMEWORK_VERSION } from '../src/config.js';
import { HarnessState } from '../src/types.js';
import {
  HARNESS_ROOT,
  createWorkspaceFixture,
  gitLogMessages,
  initPlainGitRepo,
  sampleProductSpec,
  sampleReviewReport,
  sampleStandardRequirement,
  sampleSprintContract,
} from './helpers/fixtures.js';

const fixtures: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
  const localPath = localConfigPath();
  if (existsSync(localPath)) {
    rmSync(localPath);
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

async function importFreshConfigModule(seed: string) {
  void seed;
  vi.resetModules();
  return import('../src/config.js');
}

function localConfigPath(): string {
  return resolve(HARNESS_ROOT, 'harness_config.local.json');
}

describe('M09 artifact templates and M10 framework version/compliance rules', () => {
  it('TPL_UNIT_000 validates standard_requirement.md against development-ready semantics', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'standard_requirement.md');
    writeFileSync(file, sampleStandardRequirement(), 'utf-8');
    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateFile(file);
    expect(result.valid).toBe(true);
  });

  it('TPL_UNIT_000A rejects standard_requirement.md without project name, core features, or tech stack', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'standard_requirement.md');
    writeFileSync(file, `# Untitled

## 项目概述
太短

## 不做范围
- none
`, 'utf-8');
    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Standard requirement must define at least one core feature');
    expect(result.errors).toContain('Standard requirement must define concrete tech stack constraints');
  });

  it('TPL_UNIT_001 validates product_spec.md against the required product schema', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'docs/plan/product_spec.md');
    mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
    writeFileSync(file, sampleProductSpec(), 'utf-8');
    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateFile(file);
    expect(result.valid).toBe(true);
  });

  it('TPL_UNIT_001A rejects product specs without core features or user stories', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'docs/plan/product_spec.md');
    mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
    writeFileSync(file, `# Product Spec

## 产品概述
Only overview

## 目标用户
Developers

## 核心价值
Fast delivery

## 性能
P95 < 200ms

## 兼容性
Modern browsers

## 可维护性
Modular code

## 安全
No critical vulnerabilities

## 需求边界与不做范围
- no extras
`, 'utf-8');

    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Product spec must define at least one core feature');
  });

  it('TPL_UNIT_002 validates sprint_contract_xx.md against the required contract schema', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'docs/sprint/sprint_contract_sprint-01.md');
    writeFileSync(file, sampleSprintContract(), 'utf-8');
    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateSprintContract(file);
    expect(result.valid).toBe(true);
  });

  it('TPL_UNIT_003 validates review_report_xx.md against the required review schema', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'docs/sprint/review_report_sprint-01.md');
    writeFileSync(file, sampleReviewReport(), 'utf-8');
    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateReviewReport(file);
    expect(result.valid).toBe(true);
  });

  it('TPL_UNIT_003A rejects review reports that omit scoring dimensions or sprint id', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'docs/sprint/review_report_sprint-01.md');
    writeFileSync(file, `# Review Report

## 验收基本信息
- Reviewer: evaluator-01

## 评分
- 功能完整性: 8

## 整体加权平均分
8.0

## 问题清单
- ISSUE-001 src/index.ts:1 root cause and fix suggestion

## 验收结果
通过
`, 'utf-8');

    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateReviewReport(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Review report must include a sprint identifier');
    expect(result.errors).toContain('Review report must include all 5 scoring dimensions');
  });

  it('TPL_UNIT_003B rejects review issues without precise location, root cause, and fix guidance', () => {
    const { targetDir } = useFixture();
    const file = resolve(targetDir, 'docs/sprint/review_report_sprint-01.md');
    writeFileSync(file, `# Review Report

## 验收基本信息
- Sprint ID: sprint-01
- Reviewer: evaluator-01

## 评分
- 功能完整性: 8
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8

## 整体加权平均分
8.0

## 问题清单
- ISSUE-001 there is a problem somewhere

## 修复要求
- fix ISSUE-001

## 验收结果
通过
`, 'utf-8');

    const validator = new ArtifactValidator(new Logger(resolve(targetDir, 'project_logs'), 'validator'));
    const result = validator.validateReviewReport(file);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Review issue ISSUE-001 must include a concrete file path and line number');
    expect(result.errors).toContain('Review issue ISSUE-001 must include an explicit root cause');
    expect(result.errors).toContain('Review issue ISSUE-001 must include a concrete fix suggestion');
  });

  it('TPL_UNIT_004 accepts only final_acceptance_report.md files with complete acceptance sections', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), `# Final Acceptance Report

## 全量验收
- 版本候选: v1.0.0-release-candidate

## 验收范围
- docs/plan/product_spec.md

## 核心功能覆盖
- 已检查核心流程与主路径

## 质量与风险
- 无阻断发布问题

## 验收结论
- 结论: 通过，可发布

v1.0.0-release-candidate
`, 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateFinalAcceptanceReportOrThrow()).not.toThrow();
  });

  it('TPL_UNIT_005 generates project_summary_report.md with all summary sections', () => {
    const { targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    const report = metrics.generateReport(targetDir);
    expect(report).toContain('项目基本信息');
    expect(report).toContain('Sprint执行情况汇总');
    expect(report).toContain('项目交付物清单');
    expect(report).toContain('总结与归档说明');
  });

  it('VER_UNIT_001 loads the framework baseline through loadConfig with env-backed secrets and absolute paths', async () => {
    const prevApiKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = 'test-minimax-key';

    try {
      const { loadConfig } = await importFreshConfigModule(`ver-unit-001=${Date.now()}`);
      const config = loadConfig();

      expect(config.version).toBe(FRAMEWORK_VERSION);
      expect(config.llm.apiKey).toBe('test-minimax-key');
      expect(config.llm.apiKeyEnvVar).toBe('MINIMAX_API_KEY');
      expect(config.thresholds.evaluationPassScore).toBe(7);
      expect(isAbsolute(config.paths.workspaceRoot)).toBe(true);
      expect(isAbsolute(config.paths.ideaFile)).toBe(true);
      expect(isAbsolute(config.paths.targetProject)).toBe(true);
      expect(isAbsolute(config.paths.metaLogs)).toBe(true);
    } finally {
      if (prevApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = prevApiKey;
    }
  });

  it('VER_UNIT_001A rejects plaintext API keys in local config files during real config loading', async () => {
    const path = localConfigPath();
    writeFileSync(path, JSON.stringify({
      llm: {
        apiKey: 'plaintext-secret',
      },
    }, null, 2), 'utf-8');

    const { loadConfig } = await importFreshConfigModule(`ver-unit-001a=${Date.now()}`);
    expect(() => loadConfig()).toThrow(
      'Plaintext API keys are prohibited in config files. Remove llm.apiKey from harness_config.local.json and use llm.apiKeyEnvVar instead.',
    );
  });

  it('VER_UNIT_002 exposes a semantic framework version string', () => {
    expect(FRAMEWORK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('VER_UNIT_003 keeps framework version immutable even when local config attempts to override it', async () => {
    const path = localConfigPath();
    const prevApiKey = process.env.TEST_FRAMEWORK_KEY;
    process.env.TEST_FRAMEWORK_KEY = 'override-key';
    writeFileSync(path, JSON.stringify({
      version: '9.9.9',
      llm: { apiKeyEnvVar: 'TEST_FRAMEWORK_KEY' },
    }, null, 2), 'utf-8');

    try {
      const { loadConfig } = await importFreshConfigModule(`ver-unit-003=${Date.now()}`);
      const config = loadConfig();

      expect(config.version).toBe(FRAMEWORK_VERSION);
      expect(config.version).not.toBe('9.9.9');
      expect(config.llm.apiKey).toBe('override-key');
      expect(config.llm.apiKeyEnvVar).toBe('TEST_FRAMEWORK_KEY');
    } finally {
      if (existsSync(path)) rmSync(path);
      if (prevApiKey === undefined) delete process.env.TEST_FRAMEWORK_KEY;
      else process.env.TEST_FRAMEWORK_KEY = prevApiKey;
    }
  });

  it('VER_UNIT_004 enforces safety rules and hard evaluation thresholds through runtime behavior', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const bashTool = new BashTool(targetDir);
    await expect(bashTool.execute({ command: 'git reset --hard HEAD~1' })).rejects.toThrow('SECURITY: Command blocked');

    const failingReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 5
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8

## 整体加权平均分
7.6

## 验收结果
通过
`;

    expect((harness as any).checkEvaluationPassed(failingReport)).toBe(false);
  });

  it('VER_UNIT_005 fallback flows preserve auditability by recording manual intervention in git history', async () => {
    const { metaDir, targetDir } = useFixture();
    await initPlainGitRepo(targetDir);

    const git = new GitManager(targetDir, { allowProtectedBranchCommits: true });
    await git.addAll();
    await git.commit('docs', 'project', 'seed manual intervention repo', {
      allowProtectedBranchCommit: true,
    });

    const manual = new ManualIntervention(metaDir, new Logger(resolve(metaDir, 'meta_logs'), 'manual'), targetDir);
    const record = await manual.requestIntervention('needs human', HarnessState.MANUAL_INTERVENTION, 'boom', '{}');
    const messages = await gitLogMessages(targetDir);

    expect(record.gitCommitHash).toBe('audit-commit-created');
    expect(messages[0]).toMatch(/^manual-fix\(project\): record manual intervention MI-\d+ \(needs human\)$/);
    expect(existsSync(resolve(targetDir, 'docs/sprint', `manual_intervention_${record.id}.md`))).toBe(true);
  });
});
