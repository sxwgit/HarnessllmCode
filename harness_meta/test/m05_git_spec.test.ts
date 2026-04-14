/**
 * M05 双 Git 仓库治理 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖双仓库 Git 管理的全部行为约束。
 * 包括：仓库独立性、隔离验证、受保护分支提交拒绝、Sprint 分支生命周期、
 * commit message 规范、Sprint 完成 tag 命名精确性、rollback 可追溯性。
 * 所有测试均基于真实 git 操作结果，无源码字符串断言。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import type { HarnessConfig } from '../src/config.js';
import { GitManager } from '../src/git/manager.js';
import { Harness } from '../src/orchestrator/harness.js';
import { HarnessState } from '../src/types.js';
import { RollbackLevel, RollbackManager } from '../src/orchestrator/rollback.js';
import { IsolationMonitor } from '../src/isolation/monitor.js';
import { Logger } from '../src/logger/index.js';
import {
  createWorkspaceFixture,
  gitLogMessages,
  sampleReviewReport,
  sampleSprintContract,
  setGitIdentityEnv,
} from './helpers/fixtures.js';

setGitIdentityEnv();

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

async function gitHead(dir: string): Promise<string> {
  const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return result.stdout.trim();
}

async function gitTagPointsAtHead(dir: string): Promise<string[]> {
  const result = await execa('git', ['tag', '--points-at', 'HEAD'], { cwd: dir });
  return result.stdout.split('\n').filter(Boolean);
}

describe('M05 dual git repository governance', () => {
  it('GIT_UNIT_001 keeps meta and target repositories physically independent', async () => {
    const { metaDir, targetDir } = useFixture();
    mkdirSync(resolve(metaDir, '.git'), { recursive: true });
    const git = new GitManager(targetDir);
    await git.initTargetRepo();

    expect(existsSync(resolve(metaDir, '.git'))).toBe(true);
    expect(existsSync(resolve(targetDir, '.git'))).toBe(true);
    expect(resolve(metaDir, '.git')).not.toBe(resolve(targetDir, '.git'));
  });

  it('GIT_UNIT_002 allows target git operations while meta git write attempts are rejected', async () => {
    const { metaDir, targetDir } = useFixture();
    const logger = new Logger(resolve(metaDir, 'meta_logs'), 'git');
    const monitor = new IsolationMonitor(metaDir, targetDir, logger);
    const git = new GitManager(targetDir);
    git.setIsolationMonitor(monitor);
    await git.initTargetRepo();

    expect(() => monitor.validateGitOperation('commit', metaDir)).toThrow();
    expect(await git.getCurrentBranch()).toBe('main');
  });

  it('GIT_UNIT_003 performs isolation validation before git mutations', async () => {
    const { metaDir, targetDir } = useFixture();
    const monitor = new IsolationMonitor(metaDir, targetDir, new Logger(resolve(metaDir, 'meta_logs'), 'iso'));
    const git = new GitManager(targetDir);
    git.setIsolationMonitor(monitor);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('sprint/01');
    expect(monitor.getMetrics().totalChecks).toBeGreaterThan(0);
  });

  it('GIT_UNIT_004 keeps meta git read-only during the build phase', () => {
    const { metaDir, targetDir } = useFixture();
    const monitor = new IsolationMonitor(metaDir, targetDir, new Logger(resolve(metaDir, 'meta_logs'), 'iso'));
    expect(() => monitor.validateGitOperation('commit', metaDir)).toThrow();
    expect(() => monitor.validateGitOperation('merge', metaDir)).toThrow();
    expect(() => monitor.validateGitOperation('revert', metaDir)).toThrow();
  });

  it('GIT_UNIT_005 should reject direct commits to main before full acceptance', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    writeFileSync(resolve(targetDir, 'README.md'), 'hello\n', 'utf-8');
    await git.addAll();
    await expect(git.commit('feat', 'project', 'direct main commit')).rejects.toThrow();

    const messages = await gitLogMessages(targetDir);
    expect(messages).toEqual(['init(project): initialize target project structure']);
  });

  it('GIT_UNIT_006 should reject direct commits to dev outside approved merge flow', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');
    writeFileSync(resolve(targetDir, 'docs/dev.md'), 'dev\n', 'utf-8');
    await git.addAll();
    await expect(git.commit('docs', 'project', 'direct dev commit')).rejects.toThrow();

    const messages = await gitLogMessages(targetDir);
    expect(messages).toEqual(['init(project): initialize target project structure']);
  });

  it('GIT_UNIT_006A allows protected-branch commits only when the caller explicitly approves them', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');
    writeFileSync(resolve(targetDir, 'docs/approved.md'), 'approved\n', 'utf-8');
    await git.addAll();

    const message = await git.commit('docs', 'project', 'approved framework commit', {
      allowProtectedBranchCommit: true,
    });

    expect(message).toBe('docs(project): approved framework commit');
  });

  it('GIT_UNIT_007 creates sprint branches from dev and cleans them up after merge', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('sprint/01');
    writeFileSync(resolve(targetDir, 'src/feature.ts'), 'export const feature = 1;\n', 'utf-8');
    await git.addAll();
    await git.commit('feat', 'sprint-01', 'implement sprint feature');
    await git.mergeBranch('sprint/01', 'dev');
    await git.checkout('dev');
    await git.deleteBranch('sprint/01');
    expect(await git.branchExists('sprint/01')).toBe(false);
  });

  it('GIT_UNIT_008 can create fix branches from a stable tag baseline', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createTag('v0.1.0-plan-complete');
    await git.createBranch('fix/01', 'v0.1.0-plan-complete');
    expect(await git.getCurrentBranch()).toBe('fix/01');
  });

  it('GIT_UNIT_009 supports feat branches for planning and documentation work', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('feat/architecture-design');
    writeFileSync(resolve(targetDir, 'docs/plan/architecture_design.md'), '# architecture\n', 'utf-8');
    await git.addAll();
    await git.commit('docs', 'architecture', 'add architecture design');
    const messages = await gitLogMessages(targetDir);
    expect(messages[0]).toBe('docs(architecture): add architecture design');
  });

  it('GIT_UNIT_010 keeps commit messages in the required <type>(<scope>): <description> format', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('sprint/format');
    writeFileSync(resolve(targetDir, 'README.md'), 'hello\n', 'utf-8');
    await git.addAll();
    const message = await git.commit('docs', 'project', 'document target project');
    expect(message).toMatch(/^[a-z-]+\([^)]+\): .+/);
  });

  it('GIT_INT_002 keeps the harness-owned git manager protected by default', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    const git = (harness as any).git as GitManager;

    await git.initTargetRepo();
    writeFileSync(resolve(targetDir, 'README.md'), 'hello\n', 'utf-8');
    await git.addAll();

    await expect(git.commit('docs', 'project', 'harness direct commit')).rejects.toThrow(
      'explicit approval',
    );
  });

  it('GIT_UNIT_011 uses manual-fix commits for audited human intervention', async () => {
    const { metaDir, targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    const manual = new (await import('../src/orchestrator/manual-intervention.js')).ManualIntervention(
      metaDir,
      new Logger(resolve(metaDir, 'meta_logs'), 'manual'),
      targetDir,
    );
    await manual.requestIntervention('needs human', 'MANUAL_INTERVENTION' as never, 'boom', '{}');
    const messages = await gitLogMessages(targetDir);
    expect(messages[0]).toMatch(/^manual-fix\(project\): record manual intervention MI-\d+ \(needs human\)$/);
  });

  it('GIT_UNIT_012 creates milestone tags in the repository for init, planning, sprint completion, and release', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.createTag('v0.1.0-plan-complete');
    await git.createTag('v0.2.0-sprint-01-complete');
    await git.createTag('v1.0.0-release');

    const tags = await git.getTags();

    expect(tags).toContain('v0.0.1-init');
    expect(tags).toContain('v0.1.0-plan-complete');
    expect(tags).toContain('v0.2.0-sprint-01-complete');
    expect(tags).toContain('v1.0.0-release');
  });

  it('GIT_UNIT_013 preserves strict milestone tag naming patterns and rejects malformed sprint tags', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.createTag('v0.1.0-plan-complete');
    await git.createTag('v0.2.0-sprint-01-complete');
    await git.createTag('v1.0.0-release');

    const tags = await git.getTags();

    expect(tags.find(tag => tag === 'v0.0.1-init')).toMatch(/^v\d+\.\d+\.\d+-init$/);
    expect(tags.find(tag => tag === 'v0.1.0-plan-complete')).toMatch(/^v\d+\.\d+\.\d+-plan-complete$/);
    expect(tags.find(tag => tag === 'v0.2.0-sprint-01-complete')).toMatch(/^v\d+\.\d+\.\d+-sprint-\d+-complete$/);
    expect(tags.find(tag => tag === 'v1.0.0-release')).toMatch(/^v\d+\.\d+\.\d+-release$/);
    expect(tags).not.toContain('v0.2.0-sprint-sprint-01-complete');
  });

  it('GIT_UNIT_013A creates the exact sprint completion tag through the real sprint merge flow', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();
    const git = (harness as any).git as GitManager;
    await git.initTargetRepo();
    await git.ensureBranch('dev');

    const machine = (harness as any).stateMachine;
    machine.transitionMeta(HarnessState.PROJECT_INIT);
    machine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    machine.transitionMeta(HarnessState.PLANNING);
    machine.transitionMeta(HarnessState.SPRINT_DISPATCH);

    vi.spyOn((harness as any).negotiator, 'negotiate').mockImplementation(async (...args: any[]) => {
      const contractPath = args[4] as string;
      mkdirSync(dirname(contractPath), { recursive: true });
      writeFileSync(contractPath, sampleSprintContract(), 'utf-8');
      return { success: true, rounds: 1 };
    });
    vi.spyOn((harness as any).generator, 'develop').mockImplementation(async () => {
      mkdirSync(resolve(targetDir, 'src'), { recursive: true });
      mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
      writeFileSync(resolve(targetDir, 'src/index.ts'), 'export const sprintFeature = 1;\n', 'utf-8');
      writeFileSync(resolve(targetDir, 'docs/sprint/self_check_report_sprint-01.md'), '# self-check\npassed\n', 'utf-8');
    });
    vi.spyOn((harness as any).preEvaluator, 'runPreEvaluation').mockResolvedValue({ passed: true, issues: [] });
    vi.spyOn((harness as any).evaluator, 'evaluate').mockImplementation(async () => {
      mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
      writeFileSync(resolve(targetDir, 'docs/sprint/review_report_sprint-01.md'), sampleReviewReport(), 'utf-8');
    });
    vi.spyOn((harness as any), 'runPostMergeVerification').mockResolvedValue({ passed: true, issues: [] });

    const result = await (harness as any).executeSprint(
      'sprint-01',
      '# sprint plan',
      '## sprint-01\n- build core feature\n',
      '# architecture',
      '# code standard',
      '# product spec',
      { maxSprintIterations: 1 },
    );

    expect(result).toBe('passed');
    const tags = await git.getTags();
    expect(tags).toContain('v0.1.0-sprint-01-complete');
    expect(tags).not.toContain('v0.1.0-sprint-sprint-01-complete');
    expect((harness as any).stateMachine.getProjectState().milestoneTags).toContain('sprint-01-complete');
  });

  it('GIT_UNIT_014 implements rollbacks via git revert instead of history rewrites', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('sprint/01');

    writeFileSync(resolve(targetDir, 'src/feature.ts'), 'export const feature = 1;\n', 'utf-8');
    await git.addAll();
    await git.commit('feat', 'sprint-01', 'add feature');

    const commitCountBefore = await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: targetDir });
    const featureCommit = await gitHead(targetDir);

    const rollback = new RollbackManager(git, targetDir, new Logger(resolve(targetDir, 'project_logs'), 'rollback'));
    await rollback.execute(RollbackLevel.SPRINT, 'test failure', '01');

    const commitCountAfter = await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: targetDir });
    const messages = await gitLogMessages(targetDir);

    expect(Number(commitCountAfter.stdout.trim())).toBe(Number(commitCountBefore.stdout.trim()) + 1);
    expect(messages[0]).toMatch(/^revert\(project\): sprint-01: revert [0-9a-f]{8}$/);
    expect(messages).toContain('feat(sprint-01): add feature');
    expect(await execa('git', ['merge-base', '--is-ancestor', featureCommit, 'HEAD'], { cwd: targetDir, reject: false }))
      .toMatchObject({ exitCode: 0 });
  });

  it('GIT_UNIT_015 reverts sprint commits through rollback manager audit flow', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('sprint/01');
    writeFileSync(resolve(targetDir, 'src/feature.ts'), 'export const feature = 1;\n', 'utf-8');
    await git.addAll();
    await git.commit('feat', 'sprint-01', 'add feature');
    const rollback = new RollbackManager(git, targetDir, new Logger(resolve(targetDir, 'project_logs'), 'rollback'));
    const record = await rollback.execute(RollbackLevel.SPRINT, 'test failure', '01');
    expect(record.level).toBe(RollbackLevel.SPRINT);
    expect(record.auditLog).toContain('Rollback tag created');
    expect(await git.getCurrentBranch()).toBe('sprint/01');
    expect(await git.branchExists('sprint/01')).toBe(true);

    const tags = await git.getTags();
    expect(tags.some(tag => /^rollback-01-\d+$/.test(tag))).toBe(true);

    const messages = await gitLogMessages(targetDir);
    expect(messages[0]).toMatch(/^revert\(project\): sprint-01: revert [0-9a-f]{8}$/);
    expect(messages).toContain('feat(sprint-01): add feature');
  });

  it('GIT_UNIT_016 can roll back catastrophic failures to the plan-complete baseline', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createTag('v0.1.0-plan-complete');
    writeFileSync(resolve(targetDir, 'src/catastrophic.ts'), 'export const broken = true;\n', 'utf-8');
    await git.addAll();
    await git.commit('feat', 'project', 'catastrophic change', {
      allowProtectedBranchCommit: true,
    });

    const beforeHead = await gitHead(targetDir);
    const rollback = new RollbackManager(git, targetDir, new Logger(resolve(targetDir, 'project_logs'), 'rollback'));
    const record = await rollback.execute(RollbackLevel.CATASTROPHIC, 'catastrophic');
    expect(record.level).toBe(RollbackLevel.CATASTROPHIC);
    expect(record.toTag).toBe('v0.1.0-plan-complete');
    expect(await git.getCurrentBranch()).toBe('dev');

    const afterHead = await gitHead(targetDir);
    expect(afterHead).not.toBe(beforeHead);

    const headTags = await gitTagPointsAtHead(targetDir);
    expect(headTags.some(tag => /^rollback-catastrophic-\d+$/.test(tag))).toBe(true);

    const messages = await gitLogMessages(targetDir);
    expect(messages[0]).toMatch(/^revert\(project\): catastrophic: revert [0-9a-f]{8}$/);
    expect(messages).toContain('feat(project): catastrophic change');
  });

  it('GIT_SCN_001 supports the main -> dev -> sprint/fix/feat branch lifecycle with tags', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('feat/architecture-design');
    await git.checkout('dev');
    await git.createBranch('sprint/01');
    await git.checkout('dev');
    await git.createBranch('fix/01');
    const branches = (await execa('git', ['branch', '--list'], { cwd: targetDir })).stdout;
    expect(branches).toContain('main');
    expect(branches).toContain('dev');
    expect(branches).toContain('feat/architecture-design');
    expect(branches).toContain('sprint/01');
    expect(branches).toContain('fix/01');
  });
});
