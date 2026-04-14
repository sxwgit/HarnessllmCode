import { execa } from 'execa';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { IsolationMonitor } from '../isolation/monitor.js';

interface GitManagerOptions {
  allowProtectedBranchCommits?: boolean;
}

interface CommitOptions {
  allowProtectedBranchCommit?: boolean;
}

export class GitManager {
  private targetDir: string;
  private isolationMonitor: IsolationMonitor | null = null;
  private allowProtectedBranchCommits: boolean;

  constructor(targetDir: string, options: GitManagerOptions = {}) {
    this.targetDir = targetDir;
    this.allowProtectedBranchCommits = options.allowProtectedBranchCommits ?? false;
  }

  /** Inject isolation monitor for sandbox enforcement */
  setIsolationMonitor(monitor: IsolationMonitor): void {
    this.isolationMonitor = monitor;
  }

  // ============ Repository Init ============

  async initTargetRepo(): Promise<void> {
    if (!existsSync(this.targetDir)) {
      mkdirSync(this.targetDir, { recursive: true });
    }

    // Init git repo
    await this.exec(['git', 'init']);

    // Set default branch to main
    await this.exec(['git', 'checkout', '-b', 'main']);

    // Create .gitignore
    const gitignore = `node_modules/
__pycache__/
*.pyc
venv/
.env
.DS_Store
project_logs/
project_state.json
dist/
*.tmp
*.temp
`;
    writeFileSync(resolve(this.targetDir, '.gitignore'), gitignore, 'utf-8');

    // Create directory structure
    const dirs = ['docs/plan', 'docs/sprint', 'docs/report', 'src', 'test'];
    for (const dir of dirs) {
      mkdirSync(resolve(this.targetDir, dir), { recursive: true });
    }

    // Initial commit
    await this.addAll();
    await this.commit('init', 'project', 'initialize target project structure', {
      allowProtectedBranchCommit: true,
    });
    await this.createTag('v0.0.1-init');
  }

  // ============ Branch Operations ============

  async createBranch(name: string, baseBranch = 'dev'): Promise<void> {
    if (await this.branchExists(name)) {
      this.validateGitOp(`checkout ${name}`);
      await this.exec(['git', 'checkout', name]);
      return;
    }
    this.validateGitOp(`checkout ${baseBranch}`);
    await this.exec(['git', 'checkout', baseBranch]);
    this.validateGitOp(`checkout -b ${name}`);
    await this.exec(['git', 'checkout', '-b', name]);
  }

  async checkout(branch: string): Promise<void> {
    this.validateGitOp(`checkout ${branch}`);
    // Stash all changes (including untracked and ignored) before switching branches
    await this.exec(['git', 'stash', '--all'], false);
    // Force checkout to handle any remaining untracked files
    const result = await this.exec(['git', 'checkout', branch], false);
    if (result.failed && result.stderr?.includes('would be overwritten')) {
      // Clean untracked files and retry
      await this.exec(['git', 'clean', '-fd'], false);
      await this.exec(['git', 'checkout', branch]);
    }
  }

  async mergeBranch(branch: string, targetBranch = 'dev'): Promise<boolean> {
    this.validateGitOp(`merge ${branch} into ${targetBranch}`);
    await this.exec(['git', 'checkout', targetBranch]);
    const result = await this.exec(['git', 'merge', '--no-edit', branch], false);
    return !result.failed;
  }

  async deleteBranch(name: string): Promise<void> {
    this.validateGitOp(`branch -d ${name}`);
    await this.exec(['git', 'branch', '-d', name]);
  }

  async branchExists(name: string): Promise<boolean> {
    const result = await this.exec(['git', 'branch', '--list', name]);
    return result.stdout.trim().length > 0;
  }

  // ============ Commit Operations ============

  async addAll(): Promise<void> {
    await this.exec(['git', 'add', '-A']);
  }

  async addFile(filePath: string): Promise<void> {
    await this.exec(['git', 'add', filePath]);
  }

  async commit(type: string, scope: string, description: string, options: CommitOptions = {}): Promise<string> {
    const message = `${type}(${scope}): ${description}`;
    const branch = await this.getCurrentBranch();

    if (
      this.isProtectedBranch(branch) &&
      !this.allowProtectedBranchCommits &&
      !options.allowProtectedBranchCommit
    ) {
      throw new Error(`Commits to protected branch "${branch}" require explicit approval`);
    }

    // Check if there are staged changes to commit
    const statusResult = await this.exec(['git', 'diff', '--cached', '--quiet'], false);
    if (statusResult.exitCode === 0) {
      // No staged changes — skip commit silently
      return `${message} (skipped: no changes)`;
    }

    await this.exec(['git', 'commit', '-m', message]);
    return message;
  }

  // ============ Tag Operations ============

  async createTag(tag: string, message?: string): Promise<void> {
    const msg = message || `Tag ${tag}`;
    await this.exec(['git', 'tag', '-a', tag, '-m', msg]);
  }

  async getTags(): Promise<string[]> {
    const result = await this.exec(['git', 'tag', '-l']);
    return result.stdout.trim().split('\n').filter(Boolean);
  }

  // ============ Status ============

  async getStatus(): Promise<string> {
    const result = await this.exec(['git', 'status', '--short']);
    return result.stdout;
  }

  async getLog(count = 20): Promise<string> {
    const result = await this.exec(['git', 'log', '--oneline', '-n', String(count)]);
    return result.stdout;
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.exec(['git', 'branch', '--show-current']);
    return result.stdout.trim();
  }

  // ============ Helpers ============

  private async exec(args: string[], reject = true) {
    return execa(args[0], args.slice(1), {
      cwd: this.targetDir,
      reject,
      timeout: 30_000,
    });
  }

  /** Validate git operation against isolation rules */
  private validateGitOp(operation: string): void {
    if (this.isolationMonitor) {
      this.isolationMonitor.validateGitOperation(operation, this.targetDir);
    }
  }

  private isProtectedBranch(branch: string): boolean {
    return branch === 'main' || branch === 'dev';
  }

  // ============ Revert Operations ============

  async revert(commitHash: string): Promise<void> {
    this.validateGitOp(`revert ${commitHash}`);
    await this.exec(['git', 'revert', '--no-commit', commitHash]);
  }

  async commitRevert(message: string): Promise<string> {
    this.validateGitOp('commit revert');
    return this.commit('revert', 'project', message, {
      allowProtectedBranchCommit: true,
    });
  }

  async getMergeBase(branch1: string, branch2: string): Promise<string> {
    try {
      const result = await this.exec(['git', 'merge-base', branch1, branch2], false);
      return result.stdout.trim();
    } catch {
      return 'HEAD~10';
    }
  }

  async getCommitsInRange(from: string, to: string): Promise<string[]> {
    try {
      const result = await this.exec(['git', 'rev-list', `${from}..${to}`], false);
      return result.stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  // ============ Validation ============

  async ensureBranch(branch: string): Promise<void> {
    if (!await this.branchExists(branch)) {
      const headExists = (await this.exec(['git', 'rev-parse', '--verify', 'HEAD'], false)).exitCode === 0;
      const currentBranch = await this.getCurrentBranch();

      if (!headExists && currentBranch) {
        await this.exec(['git', 'checkout', '-B', branch]);
        return;
      }

      if (branch === 'dev' && await this.branchExists('main')) {
        await this.exec(['git', 'checkout', 'main']);
        await this.exec(['git', 'checkout', '-b', 'dev']);
      } else {
        await this.createBranch(branch);
      }
    }
  }
}
