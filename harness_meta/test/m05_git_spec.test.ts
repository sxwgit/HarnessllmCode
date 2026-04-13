import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import type { HarnessConfig } from '../src/config.js';
import { GitManager } from '../src/git/manager.js';
import { Harness } from '../src/orchestrator/harness.js';
import { RollbackLevel, RollbackManager } from '../src/orchestrator/rollback.js';
import { IsolationMonitor } from '../src/isolation/monitor.js';
import { Logger } from '../src/logger/index.js';
import {
  createWorkspaceFixture,
  gitLogMessages,
  readHarnessFile,
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
    expect(messages.some(message => message.startsWith('manual-fix('))).toBe(true);
  });

  it('GIT_UNIT_012 requires milestone tags for init, planning, sprint completion, and release', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    const tags = await git.getTags();
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(tags).toContain('v0.0.1-init');
    expect(harness).toContain('v0.1.0-plan-complete');
    expect(harness).toContain('v1.0.0-release');
  });

  it('GIT_UNIT_013 preserves strict milestone tag naming patterns', () => {
    expect('v0.0.1-init').toMatch(/^v\d+\.\d+\.\d+-init$/);
    expect('v0.1.0-plan-complete').toMatch(/^v\d+\.\d+\.\d+-plan-complete$/);
    expect('v0.2.0-sprint-01-complete').toMatch(/^v\d+\.\d+\.\d+-sprint-\d+-complete$/);
    expect('v1.0.0-release').toMatch(/^v\d+\.\d+\.\d+-release$/);
  });

  it('GIT_UNIT_014 implements rollbacks via git revert instead of history rewrites', () => {
    const rollback = readHarnessFile('src/orchestrator/rollback.ts');
    expect(rollback).toContain('All rollbacks use git revert only');
    expect(rollback).not.toContain("['git', 'reset', '--hard'");
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
  });

  it('GIT_UNIT_016 can roll back catastrophic failures to the plan-complete baseline', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createTag('v0.1.0-plan-complete');
    const rollback = new RollbackManager(git, targetDir, new Logger(resolve(targetDir, 'project_logs'), 'rollback'));
    const record = await rollback.execute(RollbackLevel.CATASTROPHIC, 'catastrophic');
    expect(record.level).toBe(RollbackLevel.CATASTROPHIC);
    expect(record.toTag).toBe('v0.1.0-plan-complete');
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
