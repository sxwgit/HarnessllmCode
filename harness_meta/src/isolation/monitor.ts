import { resolve, relative } from 'node:path';
import { existsSync, realpathSync, readFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { Logger } from '../logger/index.js';

export interface IsolationViolation {
  id: string;
  timestamp: string;
  type: 'path_traversal' | 'cross_repo_write' | 'meta_write_attempt' | 'target_read_only';
  source: string;
  target: string;
  description: string;
}

export class IsolationMonitor {
  private metaDir: string;
  private targetDir: string;
  private logger: Logger;
  private violations: IsolationViolation[] = [];
  private totalChecks = 0;
  /** Tracks which meta dirs were locked so we can restore them */
  private lockedMetaDirs: Map<string, number> = new Map();

  constructor(metaDir: string, targetDir: string, logger: Logger) {
    this.metaDir = resolve(metaDir);
    this.targetDir = resolve(targetDir);
    this.logger = logger;
  }

  /**
   * Validate that a file path is within the target project sandbox
   * Returns the normalized absolute path if valid, throws otherwise
   */
  validateTargetPath(filePath: string): string {
    this.totalChecks++;
    const absPath = resolve(this.targetDir, filePath);
    const normalized = this.normalizePath(absPath);

    const targetDirSep = this.targetDir.endsWith('/') ? this.targetDir : this.targetDir + '/';
    if (!normalized.startsWith(targetDirSep) && normalized !== this.targetDir) {
      const violation = this.recordViolation(
        'path_traversal',
        filePath,
        absPath,
        `Path traversal detected: "${filePath}" resolves outside target project`,
      );
      throw new IsolationError(violation);
    }

    this.logger.debug('Path validation passed', { path: filePath });
    return normalized;
  }

  /**
   * Validate that an operation is NOT targeting the meta-program directory
   */
  validateNotMetaPath(filePath: string): void {
    this.totalChecks++;
    const absPath = resolve(filePath);
    const normalized = this.normalizePath(absPath);

    if (normalized.startsWith(this.metaDir)) {
      const violation = this.recordViolation(
        'meta_write_attempt',
        filePath,
        absPath,
        `Attempted to modify meta-program file: "${filePath}"`,
      );
      throw new IsolationError(violation);
    }
  }

  /**
   * Validate a git operation targets only the target project repository
   */
  validateGitOperation(operation: string, targetCwd: string): void {
    this.totalChecks++;
    const normalizedCwd = this.normalizePath(resolve(targetCwd));

    if (normalizedCwd.startsWith(this.metaDir)) {
      const violation = this.recordViolation(
        'cross_repo_write',
        operation,
        targetCwd,
        `Git operation "${operation}" targets meta-program repository`,
      );
      throw new IsolationError(violation);
    }

    this.logger.debug('Git operation validated', { operation, cwd: targetCwd });
  }

  /**
   * Pre-operation isolation check: verify both directories exist and are independent
   */
  verifyIsolation(): { valid: boolean; issues: string[] } {
    this.totalChecks++;
    const issues: string[] = [];

    // Check target is not inside meta (or vice versa with overlap)
    const metaNorm = this.normalizePath(this.metaDir);
    const targetNorm = this.normalizePath(this.targetDir);

    if (targetNorm.startsWith(metaNorm)) {
      issues.push('Target project directory is nested inside meta-program directory');
    }

    if (metaNorm.startsWith(targetNorm)) {
      issues.push('Meta-program directory is nested inside target project directory');
    }

    // Check .git directories are separate
    const metaGit = resolve(this.metaDir, '.git');
    const targetGit = resolve(this.targetDir, '.git');

    if (existsSync(metaGit) && existsSync(targetGit)) {
      try {
        const metaGitReal = realpathSync(metaGit);
        const targetGitReal = realpathSync(targetGit);
        if (metaGitReal === targetGitReal) {
          issues.push('Meta and target share the same .git directory');
        }
      } catch { /* ignore if can't resolve */ }
    }

    // Check target .gitignore exists
    const targetGitignore = resolve(this.targetDir, '.gitignore');
    if (existsSync(targetGitignore)) {
      // For nested scenario, ensure target is not ignored by meta
      if (targetNorm.startsWith(metaNorm)) {
        const metaGitignore = resolve(this.metaDir, '.gitignore');
        if (existsSync(metaGitignore)) {
          const metaContent = readFileSync(metaGitignore, 'utf-8');
          const targetRelPath = relative(this.metaDir, this.targetDir);
          if (!metaContent.includes(targetRelPath)) {
            issues.push('Meta-program .gitignore does not exclude target project directory');
          }
        }
      }
    }

    if (issues.length > 0) {
      this.logger.error('Isolation verification FAILED', { issues });
    } else {
      this.logger.info('Isolation verification passed');
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Get compliance metrics
   */
  getMetrics(): {
    totalChecks: number;
    violations: number;
    complianceRate: number;
    violationsByType: Record<string, number>;
  } {
    const violationsByType: Record<string, number> = {};
    for (const v of this.violations) {
      violationsByType[v.type] = (violationsByType[v.type] || 0) + 1;
    }

    return {
      totalChecks: this.totalChecks,
      violations: this.violations.length,
      complianceRate: this.totalChecks > 0
        ? ((this.totalChecks - this.violations.length) / this.totalChecks) * 100
        : 100,
      violationsByType,
    };
  }

  getViolations(): IsolationViolation[] {
    return [...this.violations];
  }

  /**
   * Lock the meta-program directory to read-only during build.
   * Per framework spec iron rule #11: "构建期设为只读"
   * Makes all files under metaDir read-only (mode 0o444 for files, 0o555 for dirs).
   */
  lockMetaDirectory(): void {
    this.logger.info('Locking meta-program source directories to read-only', { dir: this.metaDir });
    // Only lock src/ and prompts/ — NOT the root dir (which needs to remain writable
    // for meta_state.json, checkpoints, meta_logs, etc.)
    const srcDir = resolve(this.metaDir, 'src');
    const promptsDir = resolve(this.metaDir, 'prompts');
    if (existsSync(srcDir)) this.walkAndChmod(srcDir, 0o444, 0o555);
    if (existsSync(promptsDir)) this.walkAndChmod(promptsDir, 0o444, 0o555);
  }

  /**
   * Unlock the meta-program directory after build completion.
   * Restores write permissions (mode 0o644 for files, 0o755 for dirs).
   * IMPORTANT: chmod FIRST, then log — because the log file itself is read-only.
   */
  unlockMetaDirectory(): void {
    const srcDir = resolve(this.metaDir, 'src');
    const promptsDir = resolve(this.metaDir, 'prompts');
    if (existsSync(srcDir)) this.walkAndChmod(srcDir, 0o644, 0o755);
    if (existsSync(promptsDir)) this.walkAndChmod(promptsDir, 0o644, 0o755);
    this.logger.info('Meta-program source directories unlocked');
  }

  private recordViolation(
    type: IsolationViolation['type'],
    source: string,
    target: string,
    description: string,
  ): IsolationViolation {
    const violation: IsolationViolation = {
      id: `ISO-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      type,
      source,
      target,
      description,
    };

    this.violations.push(violation);
    this.logger.error(`ISOLATION VIOLATION: ${description}`, {
      violationId: violation.id,
      type,
      source,
      target,
    });

    return violation;
  }

  private normalizePath(p: string): string {
    try {
      return resolve(realpathSync(p));
    } catch {
      return resolve(p);
    }
  }

  /**
   * Recursively walk a directory and set file/dir permissions.
   * Skips node_modules and .git directories for performance.
   */
  private walkAndChmod(dir: string, fileMode: number, dirMode: number): void {
    if (!existsSync(dir)) return;
    try {
      chmodSync(dir, dirMode);
    } catch { /* some dirs may not be chmod-able */ }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip dirs that must remain writable between runs
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'meta_logs' || entry.name === 'checkpoints' || entry.name === 'audit') continue;
        const fullPath = resolve(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            this.walkAndChmod(fullPath, fileMode, dirMode);
          } else if (entry.isFile()) {
            // Skip state files that must remain writable
            if (entry.name === 'meta_state.json' || entry.name === 'harness_config.json') continue;
            chmodSync(fullPath, fileMode);
          }
        } catch { /* skip files we can't chmod */ }
      }
    } catch { /* can't read dir */ }
  }
}

export class IsolationError extends Error {
  violation: IsolationViolation;

  constructor(violation: IsolationViolation) {
    super(violation.description);
    this.name = 'IsolationError';
    this.violation = violation;
  }
}
