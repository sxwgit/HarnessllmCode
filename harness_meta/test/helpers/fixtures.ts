import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { Logger } from '../../src/logger/index.js';

const cwd = process.cwd();

export const HARNESS_ROOT = existsSync(resolve(cwd, 'src'))
  ? resolve(cwd)
  : resolve(cwd, 'harness_meta');

export const WORKSPACE_ROOT = resolve(HARNESS_ROOT, '..');

export function readHarnessFile(relativePath: string): string {
  return readFileSync(resolve(HARNESS_ROOT, relativePath), 'utf-8');
}

export function createTempDir(prefix = 'harness-spec-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createWorkspaceFixture(prefix = 'harness-workspace-') {
  const { dir, cleanup } = createTempDir(prefix);
  const rootDir = realpathSync(dir);
  const metaDir = resolve(rootDir, 'harness_meta');
  const targetDir = resolve(rootDir, 'target_project');
  const metaLogs = resolve(metaDir, 'meta_logs');
  const projectLogs = resolve(targetDir, 'project_logs');

  mkdirSync(resolve(metaDir, 'src'), { recursive: true });
  mkdirSync(resolve(metaDir, 'prompts'), { recursive: true });
  mkdirSync(metaLogs, { recursive: true });
  mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
  mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
  mkdirSync(resolve(targetDir, 'src'), { recursive: true });
  mkdirSync(resolve(targetDir, 'test'), { recursive: true });
  mkdirSync(projectLogs, { recursive: true });

  writeFileSync(resolve(metaDir, 'harness_config.json'), '{}', 'utf-8');
  writeFileSync(resolve(metaDir, '.gitignore'), 'target_project/\nmeta_logs/\nmeta_state.json\n', 'utf-8');
  writeFileSync(resolve(targetDir, 'idea.md'), '# idea\n', 'utf-8');

  return {
    rootDir,
    metaDir,
    targetDir,
    metaLogs,
    projectLogs,
    cleanup,
  };
}

export function makeLogger(logDir: string, module = 'test'): Logger {
  return new Logger(logDir, module);
}

export function setGitIdentityEnv(): void {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'Harness Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'harness-test@example.com';
  process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME;
  process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL;
  process.env.GIT_CONFIG_COUNT = process.env.GIT_CONFIG_COUNT || '1';
  process.env.GIT_CONFIG_KEY_0 = process.env.GIT_CONFIG_KEY_0 || 'init.defaultBranch';
  process.env.GIT_CONFIG_VALUE_0 = process.env.GIT_CONFIG_VALUE_0 || 'master';
}

export async function initPlainGitRepo(dir: string): Promise<void> {
  setGitIdentityEnv();
  mkdirSync(dir, { recursive: true });
  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['checkout', '-b', 'main'], { cwd: dir, reject: false });
}

export async function gitLogMessages(dir: string): Promise<string[]> {
  const result = await execa('git', ['log', '--pretty=%s'], { cwd: dir, reject: false });
  return result.stdout.split('\n').filter(Boolean);
}

export function writeFile(relativeOrAbsolutePath: string, content: string): void {
  const targetPath = resolve(relativeOrAbsolutePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf-8');
}

export function sampleSprintContract(): string {
  return `# Sprint Contract

## Sprint basic information
- sprint-01

## Sprint基本信息
- ID: sprint-01
- Iteration: 1

## Core goals
- Build a runnable feature

## 核心目标
- Implement feature one

## 功能点交付清单
- F-001: add entry point

## 验收标准
- The app starts successfully

## 测试用例
- TC-001: start app

## 交付物
- src/index.ts
- test/index.test.ts

## 代码规范与架构合规要求
- follow architecture

## 安全编码要求
- no hardcoded secrets

## 双方确认
- Generator: gen-001 @ 2026-04-08T00:00:00.000Z
- Evaluator: eval-001 @ 2026-04-08T00:00:00.000Z
`;
}

export function sampleReviewReport(): string {
  return `# Review Report

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
7.8

## 问题清单
- ISSUE-001 src/index.ts:1 root cause: missing bootstrap export fix suggestion: add explicit bootstrap export and wire startup entry

## 修复要求
- fix ISSUE-001

## 验收结果
通过

## 验收人签字
- evaluator-01 @ 2026-04-08T00:00:00.000Z
`;
}

export function sampleStandardRequirement(): string {
  return `# Demo Project

## 项目名称
- Demo Project

## 项目概述
一个可运行的演示项目，用于验证严格测试驱动开发流程。

## 核心功能清单
- F-001 用户登录 (P0)
- F-002 看板展示 (P1)

## 技术栈要求
- Runtime: Node.js 20
- Language: TypeScript
- Framework: Express
- Dependency: Vitest

## 约束条件
- 必须保留 Git 可追溯性

## 不做范围
- 不实现第三方支付
`;
}

export function sampleProductSpec(): string {
  return `# Product Spec

## 产品概述
This is a sample product.

## 目标用户
Developers

## 核心价值
Fast delivery

## 核心功能
- F-001 login feature
- F-002 dashboard feature

## 用户故事与验收标准
- As a user, I can log in

## 性能
P95 < 200ms

## 兼容性
Modern browsers

## 可维护性
Modular code

## 可用性
Accessible UX

## 安全
No critical vulnerabilities

## 需求边界与不做范围
- No payments

## 术语表
- MVP
`;
}
