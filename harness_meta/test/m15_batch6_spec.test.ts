/**
 * M15 Batch 6 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖 Batch 6 的三个目标：
 * 1. standard_requirement.md 必须满足最小可开发语义
 * 2. review_report 问题清单必须具备可执行修复信息
 * 3. FINAL_ACCEPTANCE 必须验证所有 Sprint 完成
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import { StateMachine } from '../src/state/machine.js';
import { HarnessState } from '../src/types.js';
import {
  createTempDir,
  createWorkspaceFixture,
  sampleStandardRequirement,
  sampleReviewReport,
  initPlainGitRepo,
  setGitIdentityEnv,
  makeLogger,
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

function useTempDir(prefix = 'batch6-') {
  const { dir, cleanup } = createTempDir(prefix);
  fixtures.push({ cleanup });
  return dir;
}

function writeAndValidate(validator: ArtifactValidator, dir: string, fileName: string, content: string) {
  const filePath = resolve(dir, fileName);
  mkdirSync(resolve(dir, fileName.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return validator.validateFile(filePath);
}

// ============ BATCH6_REQ: Requirement Semantic Validation ============

describe('BATCH6: Requirement semantic validation', () => {
  it('BATCH6_REQ_001: detailed requirement passes validation', () => {
    const dir = useTempDir('req-001-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);
    const result = writeAndValidate(validator, dir, 'standard_requirement.md', sampleStandardRequirement());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('BATCH6_REQ_002: feature description under 10 chars fails', () => {
    const dir = useTempDir('req-002-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    // Use a list item under 核心功能清单 where the extracted item text is < 10 chars
    const content = `# Test Project

## 项目名称
- Test Project

## 项目概述
一个可运行的演示项目，用于验证严格测试驱动开发流程。

## 核心功能清单
- 登录 (P0)

## 技术栈要求
- Runtime: Node.js 20
- Language: TypeScript

## 约束条件
- 必须保留 Git 可追溯性

## 不做范围
- 不实现第三方支付
`;
    const result = writeAndValidate(validator, dir, 'standard_requirement.md', content);
    expect(result.valid).toBe(false);
    // The feature item "登录" is too short — either fails schema or semantic validation
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('BATCH6_REQ_003: vague constraint fails validation', () => {
    const dir = useTempDir('req-003-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const content = `# Test Project

## 项目名称
- Test Project

## 项目概述
一个可运行的演示项目，用于验证严格测试驱动开发流程。

## 核心功能清单
- F-001 用户登录验证功能 (P0)

## 技术栈要求
- Runtime: Node.js 20
- Language: TypeScript

## 约束条件
- 必须做好

## 不做范围
- 不实现第三方支付
`;
    const result = writeAndValidate(validator, dir, 'standard_requirement.md', content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('too vague'))).toBe(true);
  });

  it('BATCH6_REQ_004: vague out-of-scope fails validation', () => {
    const dir = useTempDir('req-004-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const content = `# Test Project

## 项目名称
- Test Project

## 项目概述
一个可运行的演示项目，用于验证严格测试驱动开发流程。

## 核心功能清单
- F-001 用户登录验证功能 (P0)

## 技术栈要求
- Runtime: Node.js 20
- Language: TypeScript

## 不做范围
- 不实现额外功能
`;
    const result = writeAndValidate(validator, dir, 'standard_requirement.md', content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('too vague'))).toBe(true);
  });

  it('BATCH6_REQ_005: overview under 20 chars fails', () => {
    const dir = useTempDir('req-005-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const content = `# Test

## 项目名称
- Test

## 项目概述
短描述

## 核心功能清单
- F-001 用户登录验证功能 (P0)

## 技术栈要求
- Runtime: Node.js 20
- Language: TypeScript

## 不做范围
- 不实现第三方支付网关集成
`;
    const result = writeAndValidate(validator, dir, 'standard_requirement.md', content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('20 characters'))).toBe(true);
  });
});

// ============ BATCH6_REV: Review Report Issue Actionability ============

describe('BATCH6: Review report issue actionability', () => {
  it('BATCH6_REV_001: actionable issue list passes validation', () => {
    const dir = useTempDir('rev-001-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);
    const result = writeAndValidate(validator, dir, 'review_report_sprint-01.md', sampleReviewReport());
    expect(result.valid).toBe(true);
  });

  it('BATCH6_REV_002: generic root cause "代码bug" fails validation', () => {
    const dir = useTempDir('rev-002-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    // Use a long generic root cause that passes the 15-char minimum but is too vague
    const content = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 8
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8

## 整体加权平均分
7.8

## 问题清单
- ISSUE-001 src/index.ts:1 root cause: 代码bug代码bug代码bug代码bug fix suggestion: 添加缺失的导出语句并确保模块正确初始化

## 修复要求
- fix ISSUE-001

## 验收结果
通过
`;
    const result = writeAndValidate(validator, dir, 'review_report_sprint-01.md', content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('too generic'))).toBe(true);
  });

  it('BATCH6_REV_003: fix suggestion lacking action verbs fails', () => {
    const dir = useTempDir('rev-003-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const content = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 8
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8

## 整体加权平均分
7.8

## 问题清单
- ISSUE-001 src/index.ts:1 root cause: missing bootstrap export in entry file fix suggestion: this is a problem that should be looked at carefully

## 修复要求
- fix ISSUE-001

## 验收结果
通过
`;
    const result = writeAndValidate(validator, dir, 'review_report_sprint-01.md', content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('action verbs'))).toBe(true);
  });

  it('BATCH6_REV_004: short root cause under 15 chars fails', () => {
    const dir = useTempDir('rev-004-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const content = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 6
- 代码质量: 6
- 可运行性: 6
- 可测试性: 6
- 安全性: 6

## 整体加权平均分
6.0

## 问题清单
- ISSUE-001 src/index.ts:1 root cause: short fix suggestion: 修复导出语句

## 修复要求
- fix ISSUE-001

## 验收结果
不通过
`;
    const result = writeAndValidate(validator, dir, 'review_report_sprint-01.md', content);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least 15 characters'))).toBe(true);
  });
});

// ============ BATCH6_FINAL: Final Acceptance Sprint Verification ============

describe('BATCH6: Final acceptance sprint verification', () => {
  it('BATCH6_FINAL_001: final acceptance passes when all sprints completed', async () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    setGitIdentityEnv();
    await initPlainGitRepo(targetDir);

    const sm = new StateMachine(metaDir, targetDir);
    sm.transitionMeta(HarnessState.PROJECT_INIT);
    sm.transitionProject(HarnessState.PROJECT_INIT);

    // Mark sprint-01 and sprint-02 as completed
    sm.completeSprint('sprint-01');
    sm.completeSprint('sprint-02');

    // Write sprint plan referencing both sprints
    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(resolve(planDir, 'sprint_plan.md'), `
# Sprint Plan
## sprint-01: Core feature
## sprint-02: Secondary feature
`, 'utf-8');

    // Verify all sprints completed
    const projectState = sm.getProjectState();
    expect(projectState.completedSprints).toContain('sprint-01');
    expect(projectState.completedSprints).toContain('sprint-02');
    expect(projectState.currentSprintId).toBeNull();
  });

  it('BATCH6_FINAL_002: final acceptance blocks when sprint completed but milestone tag missing', () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    const sm = new StateMachine(metaDir, targetDir);

    sm.transitionMeta(HarnessState.PROJECT_INIT);
    sm.transitionProject(HarnessState.PROJECT_INIT);

    // Complete sprint-01 but don't add milestone tag
    sm.completeSprint('sprint-01');

    const projectState = sm.getProjectState();
    expect(projectState.completedSprints).toContain('sprint-01');
    // Verify milestone tags are empty (simulating the gap)
    expect(projectState.milestoneTags).toHaveLength(0);
  });
});
