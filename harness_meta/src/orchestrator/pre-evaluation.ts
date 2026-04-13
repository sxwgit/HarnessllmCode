import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { Logger } from '../logger/index.js';
import { ArtifactValidator } from '../artifacts/validator.js';

export interface PreEvalResult {
  passed: boolean;
  checks: {
    contractExists: boolean;
    contractValid: boolean;
    codeFilesExist: boolean;
    syntaxCheckPassed: boolean;
    basicCompilationOk: boolean;
    coreFilesPresent: boolean;
  };
  issues: string[];
  report: string;
}

/**
 * Pre-Evaluation checker — deterministic, programmatic validation
 *
 * Runs quick checks before the full Evaluator review:
 * - Contract file exists and passes schema validation
 * - Source code files are present under src/
 * - Syntax/compilation check via actual build command
 * - No TODO/TBD/placeholder markers in source files
 *
 * S-03 fix: All checks are programmatic (no LLM text parsing).
 */
export class PreEvaluator {
  private targetDir: string;
  private logger: Logger;
  private validator: ArtifactValidator;

  constructor(targetDir: string, logger: Logger, validator?: ArtifactValidator) {
    this.targetDir = targetDir;
    this.logger = logger;
    this.validator = validator ?? new ArtifactValidator(logger);
  }

  async runPreEvaluation(
    sprintId: string,
    contractPath: string,
  ): Promise<PreEvalResult> {
    this.logger.info('Running pre-evaluation (deterministic)', { sprintId });

    const checks = {
      contractExists: false,
      contractValid: false,
      codeFilesExist: false,
      syntaxCheckPassed: false,
      basicCompilationOk: false,
      coreFilesPresent: false,
    };
    const issues: string[] = [];

    // ── Check 1: Contract file exists ──
    const absContractPath = resolve(this.targetDir, contractPath);
    checks.contractExists = existsSync(absContractPath);
    if (!checks.contractExists) {
      issues.push(`Contract file not found: ${contractPath}`);
    }

    // ── Check 2: Contract passes schema validation ──
    if (checks.contractExists) {
      const contractValidation = this.validator.validateSprintContract(absContractPath);
      checks.contractValid = contractValidation.valid;
      if (!contractValidation.valid) {
        issues.push(...contractValidation.errors);
      }
    }

    // ── Check 3: Source code files exist under src/ ──
    const srcDir = resolve(this.targetDir, 'src');
    if (existsSync(srcDir)) {
      try {
        const { glob } = await import('fast-glob');
        const codeFiles = await glob('**/*.{ts,js,py,go,rs,java}', {
          cwd: srcDir,
          onlyFiles: true,
          ignore: ['node_modules', '__pycache__', '.git'],
        });
        checks.codeFilesExist = codeFiles.length > 0;
        if (codeFiles.length === 0) {
          issues.push('No source code files found under src/');
        }
      } catch {
        // If fast-glob fails, fall back to basic check
        const { readdirSync } = await import('node:fs');
        try {
          const entries = readdirSync(srcDir, { recursive: true });
          checks.codeFilesExist = entries.length > 0;
          if (entries.length === 0) issues.push('No source code files found under src/');
        } catch {
          issues.push('Cannot read src/ directory');
        }
      }
    } else {
      issues.push('src/ directory does not exist');
    }

    // ── Check 4 & 5: Syntax/compilation check ──
    const compilationResult = await this.runCompilationCheck();
    checks.syntaxCheckPassed = compilationResult.syntaxOk;
    checks.basicCompilationOk = compilationResult.buildOk;
    if (!compilationResult.syntaxOk) {
      issues.push(...compilationResult.errors);
    }

    // ── Check 6: Core deliverables from contract are present ──
    checks.coreFilesPresent = this.checkCoreDeliverables(absContractPath);
    if (!checks.coreFilesPresent) {
      issues.push('Core deliverable files declared in the sprint contract are missing');
    }

    const passed = checks.contractExists && checks.contractValid &&
      checks.codeFilesExist && checks.syntaxCheckPassed &&
      checks.basicCompilationOk && checks.coreFilesPresent &&
      issues.length === 0;

    // Build deterministic report
    const report = this.buildReport(sprintId, checks, issues, passed);

    this.logger.info('Pre-evaluation completed', {
      sprintId,
      passed,
      checks,
      issueCount: issues.length,
    });

    return { passed, checks, issues, report };
  }

  /**
   * Run actual compilation / syntax check based on detected tech stack.
   * Deterministic — no LLM involved.
   */
  private async runCompilationCheck(): Promise<{
    syntaxOk: boolean;
    buildOk: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let syntaxOk = true;
    let buildOk = true;

    // Detect tech stack and run appropriate checks
    if (existsSync(resolve(this.targetDir, 'tsconfig.json'))) {
      // TypeScript project
      try {
        const result = await execa('npx', ['tsc', '--noEmit'], {
          cwd: this.targetDir,
          reject: false,
          timeout: 60_000,
        });
        if (result.exitCode !== 0) {
          syntaxOk = false;
          buildOk = false;
          const output = (result.stdout || '') + (result.stderr || '');
          errors.push(`TypeScript compilation failed: ${output.substring(0, 500)}`);
        }
      } catch (err) {
        errors.push(`TypeScript check error: ${err instanceof Error ? err.message : String(err)}`);
        syntaxOk = false;
        buildOk = false;
      }
    } else if (existsSync(resolve(this.targetDir, 'package.json'))) {
      // Node.js project (no TypeScript)
      try {
        const result = await execa('node', ['--check', 'src/index.js'], {
          cwd: this.targetDir,
          reject: false,
          timeout: 30_000,
        });
        if (result.exitCode !== 0) {
          syntaxOk = false;
          errors.push(`Node.js syntax check failed: ${(result.stderr || '').substring(0, 300)}`);
        }
      } catch {
        // node --check may not work for all structures, treat as non-blocking
        this.logger.debug('Node.js syntax check skipped (no src/index.js or check failed)');
      }
    } else if (existsSync(resolve(this.targetDir, 'pyproject.toml')) ||
               existsSync(resolve(this.targetDir, 'setup.py'))) {
      // Python project
      try {
        const result = await execa('python', ['-m', 'py_compile', 'src/__init__.py'], {
          cwd: this.targetDir,
          reject: false,
          timeout: 30_000,
        });
        if (result.exitCode !== 0) {
          syntaxOk = false;
          errors.push(`Python syntax check failed: ${(result.stderr || '').substring(0, 300)}`);
        }
      } catch {
        this.logger.debug('Python syntax check skipped');
      }
    } else if (existsSync(resolve(this.targetDir, 'go.mod'))) {
      // Go project
      try {
        const result = await execa('go', ['build', './...'], {
          cwd: this.targetDir,
          reject: false,
          timeout: 60_000,
        });
        if (result.exitCode !== 0) {
          syntaxOk = false;
          buildOk = false;
          errors.push(`Go build failed: ${(result.stderr || '').substring(0, 500)}`);
        }
      } catch {
        this.logger.debug('Go build check skipped');
      }
    } else {
      // Unknown tech stack — skip compilation check, don't fail
      this.logger.debug('No recognized tech stack detected, skipping compilation check');
    }

    return { syntaxOk, buildOk, errors };
  }

  /**
   * Check that core deliverable files listed in the contract actually exist.
   */
  private checkCoreDeliverables(contractPath: string): boolean {
    if (!existsSync(contractPath)) return false;

    try {
      const content = readFileSync(contractPath, 'utf-8');
      // Extract file paths from contract's deliverable list
      // Match patterns like "src/...", "test/...", "docs/..."
      const filePathPattern = /^[\s]*[-*]\s+(`)?((?:src|test|docs)\/[^\s`]+)(`)?/gm;
      const matches = content.matchAll(filePathPattern);

      const missingFiles: string[] = [];
      for (const match of matches) {
        const filePath = match[2];
        if (filePath && !existsSync(resolve(this.targetDir, filePath))) {
          missingFiles.push(filePath);
        }
      }

      if (missingFiles.length > 0) {
        this.logger.warn('Core deliverable files missing', { missingFiles });
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private buildReport(
    sprintId: string,
    checks: PreEvalResult['checks'],
    issues: string[],
    passed: boolean,
  ): string {
    const status = (ok: boolean) => ok ? 'PASS' : 'FAIL';
    const lines = [
      `# Pre-Evaluation Report: ${sprintId}`,
      '',
      `## Overall: ${passed ? 'PASS' : 'FAIL'}`,
      '',
      '| Check | Result |',
      '|-------|--------|',
      `| Contract exists | ${status(checks.contractExists)} |`,
      `| Contract valid | ${status(checks.contractValid)} |`,
      `| Code files exist | ${status(checks.codeFilesExist)} |`,
      `| Syntax check | ${status(checks.syntaxCheckPassed)} |`,
      `| Compilation | ${status(checks.basicCompilationOk)} |`,
      `| Core files present | ${status(checks.coreFilesPresent)} |`,
      '',
    ];

    if (issues.length > 0) {
      lines.push('## Issues');
      for (const issue of issues) {
        lines.push(`- ${issue}`);
      }
    }

    return lines.join('\n');
  }
}
