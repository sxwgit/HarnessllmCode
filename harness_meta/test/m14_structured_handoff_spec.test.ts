/**
 * M14 结构化交接与反作弊 — 测试分类: anti-cheat + behavioral
 *
 * 验证意图：覆盖 ArtifactValidator 的结构化提取和反作弊能力。
 * 包括：ReviewReport 结构化解析、"通过"但分数不达标拒绝、缺维度拒绝、
 * 空壳 architecture/sprint plan 拒绝、harness 集成验证。
 * 所有测试验证真实 ArtifactValidator 返回值，无源码字符串断言。
 */
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessConfig } from '../src/config.js';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import { Harness } from '../src/orchestrator/harness.js';
import { createWorkspaceFixture, makeLogger, sampleReviewReport } from './helpers/fixtures.js';

const fixtures: Array<{ cleanup: () => void }> = [];
afterEach(() => {
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

describe('M14 structured handoff hardening', () => {
  it('STRUCT_UNIT_001 ReviewReport structured parsing extracts passed/scores/average from complete report', () => {
    const { metaDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const result = validator.extractReviewReportData(sampleReviewReport());

    expect(result.sprintId).toBe('sprint-01');
    expect(result.passed).toBe(true);
    expect(result.scores.length).toBe(5);
    expect(result.weightedAverage).toBe(7.8);

    // Verify all 5 dimensions present
    const dimensionNames = result.scores.map(s => s.dimension);
    expect(dimensionNames).toContain('功能完整性');
    expect(dimensionNames).toContain('代码质量与架构合规性');
    expect(dimensionNames).toContain('可运行性与稳定性');
    expect(dimensionNames).toContain('可测试性与文档完整性');
    expect(dimensionNames).toContain('代码安全性');
  });

  it('STRUCT_UNIT_002 (anti-cheat) ReviewReport with "通过" text but scores below threshold', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const cheatingReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 4
- 代码质量: 3
- 可运行性: 4
- 可测试性: 3
- 安全性: 4

## 整体加权平均分
3.6

## 问题清单

## 修复要求

## 验收结果
通过
`;
    const reportPath = resolve(targetDir, 'docs/sprint/review_report_sprint-01.md');
    writeFileSync(reportPath, cheatingReport, 'utf-8');

    const result = validator.extractReviewReportData(cheatingReport);
    const validation = validator.validateReviewReport(reportPath);

    expect(result.passed).toBe(true);
    expect(result.weightedAverage).toBe(3.6);
    expect(validation.valid).toBe(true);
    expect(result.weightedAverage).toBeLessThan(7);
    for (const score of result.scores) {
      expect(score.score).toBeLessThan(6);
    }
    expect((harness as any).checkEvaluationPassed(cheatingReport)).toBe(false);
  });

  it('STRUCT_UNIT_003 (anti-cheat) ReviewReport missing scoring dimensions', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const incompleteReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 8

## 整体加权平均分
8.0

## 验收结果
通过
`;
    const reportPath = resolve(targetDir, 'docs/sprint/review_report_sprint-01.md');
    writeFileSync(reportPath, incompleteReport, 'utf-8');

    const result = validator.extractReviewReportData(incompleteReport);
    const validation = validator.validateReviewReport(reportPath);

    expect(result.scores.length).toBeLessThan(5);
    expect(result.passed).toBe(true);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Review report must include all 5 scoring dimensions');
    expect((harness as any).checkEvaluationPassed(incompleteReport)).toBe(false);
  });

  it('STRUCT_UNIT_004 ReviewReport with "不通过" conclusion', () => {
    const { metaDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const failReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 5
- 代码质量: 5
- 可运行性: 5
- 可测试性: 5
- 安全性: 5

## 整体加权平均分
5.0

## 问题清单
- ISSUE-001 src/main.ts:1 root cause: missing entry fix suggestion: add entry point

## 验收结果
不通过
`;
    const result = validator.extractReviewReportData(failReport);

    // "不通过" contains "通过" but also "不通过"
    // The logic: content.includes('通过') && !content.includes('不通过')
    // Since "不通过" is present, this should be false
    expect(result.passed).toBe(false);
    expect(result.weightedAverage).toBe(5.0);
  });

  it('STRUCT_UNIT_005 ArchitectureDesign structured extraction extracts layers and modules', () => {
    const { metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const archContent = `# Architecture Design

## 整体架构
Layered architecture with 3 tiers.

## 架构层次
- Presentation Layer: handles HTTP requests and responses
- Business Logic Layer: core domain logic
- Data Access Layer: database operations

## 核心模块
- AuthModule: authentication and authorization
- UserModule: user management CRUD

## 数据模型
- User: represents a system user
- Session: represents an active session

## 技术栈
- Runtime: Node.js 20
- Language: TypeScript 5.3
- Framework: Express.js
`;

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    const archPath = resolve(planDir, 'architecture_design.md');
    writeFileSync(archPath, archContent, 'utf-8');

    const result = validator.validateFile(archPath);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.file).toBe(archPath);
  });

  it('STRUCT_UNIT_006 (anti-cheat) ArchitectureDesign with only title fails validation', () => {
    const { metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    const archPath = resolve(planDir, 'architecture_design.md');
    writeFileSync(archPath, '# Architecture Design\n\n## 架构层次\n\n## 核心模块\n\n## 数据模型\n\n## 技术栈\n- Runtime: Node.js\n- Language: TypeScript\n', 'utf-8');

    const result = validator.validateFile(archPath);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Architecture design must define at least one concrete layer when layer sections are declared');
    expect(result.errors).toContain('Architecture design must define at least one concrete core module when module sections are declared');
    expect(result.errors).toContain('Architecture design must define at least one concrete data model when model sections are declared');
  });

  it('STRUCT_UNIT_007 SprintPlan structured extraction extracts sprints and milestones', () => {
    const { metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const sprintPlanContent = `# Sprint Plan

## Sprint sprint-01: Core Feature
- 目标: Implement user authentication
- 交付: src/auth.ts, test/auth.test.ts
- 工作量: 5

## Sprint sprint-02: Dashboard
- 目标: Build dashboard UI
- 交付: src/dashboard.ts
- 工作量: 7

## 里程碑
- v0.1.0-plan-complete: sprint-01 sprint-02 complete
`;

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    const planPath = resolve(planDir, 'sprint_plan.md');
    writeFileSync(planPath, sprintPlanContent, 'utf-8');

    const result = validator.validateFile(planPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.file).toBe(planPath);
  });

  it('STRUCT_UNIT_008 (anti-cheat) SprintPlan without sprint identifiers', () => {
    const { metaDir, targetDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const badPlan = `# Sprint Plan

## Phase 1
Build core features.

## Phase 2
Build dashboard.

## 里程碑
- v1.0.0: all done
`;

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(resolve(planDir, 'sprint_plan.md'), badPlan, 'utf-8');

    const result = validator.validateFile(resolve(planDir, 'sprint_plan.md'));
    // No sprint-\d+ identifiers should fail semantic validation
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sprint identifier'))).toBe(true);
  });

  it('STRUCT_UNIT_009 extractReviewReportData is a public method on ArtifactValidator', () => {
    const { metaDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    // Method should exist and be callable
    expect(typeof validator.extractReviewReportData).toBe('function');

    // Should handle empty content gracefully
    const emptyResult = validator.extractReviewReportData('');
    expect(emptyResult.sprintId).toBe('');
    expect(emptyResult.passed).toBe(false);
    expect(emptyResult.scores).toEqual([]);
    expect(emptyResult.weightedAverage).toBeNaN();
  });

  it('STRUCT_UNIT_010 structured evaluation parsing is used in harness', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect((harness as any).checkEvaluationPassed(sampleReviewReport())).toBe(true);

    const ambiguousReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 8
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8

## 整体加权平均分
8.0

## 验收结果
待确认
`;

    expect((harness as any).checkEvaluationPassed(ambiguousReport)).toBe(false);
  });
});
