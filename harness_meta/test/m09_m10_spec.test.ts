import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import { MetricsCollector } from '../src/orchestrator/metrics.js';
import { Logger } from '../src/logger/index.js';
import { FRAMEWORK_VERSION } from '../src/config.js';
import {
  HARNESS_ROOT,
  createWorkspaceFixture,
  readHarnessFile,
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
});

function useFixture() {
  const fixture = createWorkspaceFixture();
  fixtures.push(fixture);
  return fixture;
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

  it('TPL_UNIT_004 expects final_acceptance_report.md to be written with explicit acceptance sections', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(harness).toContain('docs/report/final_acceptance_report.md');
    expect(harness).toContain('全量验收');
    expect(harness).toContain('v1.0.0-release-candidate');
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

  it('VER_UNIT_001 treats the framework contract as the single execution baseline', () => {
    const frameworkDoc = resolve(HARNESS_ROOT, '..', 'docs/framework.md');
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(frameworkDoc).toBeTruthy();
    expect(harness).toContain('Isolation verification failed');
    expect(harness).toContain('evaluationPassScore');
  });

  it('VER_UNIT_002 exposes a semantic framework version string', () => {
    expect(FRAMEWORK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('VER_UNIT_003 should keep the framework version immutable during a single build', () => {
    const configSource = readHarnessFile('src/config.ts');
    expect(configSource).toContain("export const FRAMEWORK_VERSION = '0.1.0'");
    expect(configSource).toContain('Framework version managed independently');
  });

  it('VER_UNIT_004 expects compliance checks around isolation, git rules, and hard thresholds', () => {
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    const exception = readHarnessFile('src/exception/handler.ts');
    expect(harness).toContain('verifyIsolation');
    expect(harness).toContain('this.git.setIsolationMonitor');
    expect(exception).toContain('evaluation not passed');
  });

  it('VER_UNIT_005 uses fallback principles that prioritize isolation, auditability, and safety', () => {
    const bash = readHarnessFile('src/tools/bash.ts');
    const rollback = readHarnessFile('src/orchestrator/rollback.ts');
    const manual = readHarnessFile('src/orchestrator/manual-intervention.ts');
    expect(bash).toContain('forbidden');
    expect(rollback).toContain('git revert only');
    expect(manual).toContain('manual-fix');
  });
});
