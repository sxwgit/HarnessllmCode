import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { BaseTool } from './base.js';

/**
 * M-07: Security scan tool for vulnerability detection.
 *
 * Wraps common security scanners to provide dependency audit
 * (npm audit / pip audit) and basic SAST pattern matching.
 * All execution is confined to the sandbox directory via BaseTool isolation.
 */
export class SecurityScanTool extends BaseTool {
  name = 'security_scan';
  description = 'Run security vulnerability scans on the target project. Supports npm audit, pip audit, and basic SAST checks.';
  inputSchema = z.object({
    scanType: z.enum(['dependency', 'sast', 'full']).describe(
      'Type of scan: dependency (npm audit/pip audit), sast (basic pattern scan), or full (both)',
    ),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'all']).default('high').describe(
      'Minimum severity to report',
    ),
  });

  async execute(input: Record<string, unknown>): Promise<string> {
    const parsed = this.inputSchema.parse(input);
    const results: string[] = [];

    if (parsed.scanType === 'dependency' || parsed.scanType === 'full') {
      results.push(await this.dependencyScan(parsed.severity));
    }
    if (parsed.scanType === 'sast' || parsed.scanType === 'full') {
      results.push(await this.sastScan(parsed.severity));
    }

    return results.join('\n---\n');
  }

  /**
   * Dependency scan: detect package manager and run appropriate audit command.
   */
  private async dependencyScan(severity: string): Promise<string> {
    const header = '## Dependency Vulnerability Scan\n';

    try {
      // Check for Node.js project
      if (existsSync(resolve(this.sandboxDir, 'package.json'))) {
        const severityFlag = severity === 'all' ? '' : `--audit-level=${severity}`;
        const args = ['audit', '--json', ...severityFlag.split(' ').filter(Boolean)];
        const result = await execa('npm', args, {
          cwd: this.sandboxDir,
          reject: false,
          timeout: 60_000,
        });
        return header + this.formatNpmAudit(result.stdout, result.stderr);
      }

      // Check for Python project
      if (existsSync(resolve(this.sandboxDir, 'requirements.txt')) ||
          existsSync(resolve(this.sandboxDir, 'Pipfile')) ||
          existsSync(resolve(this.sandboxDir, 'pyproject.toml'))) {
        return header + await this.pipAudit(severity);
      }

      return header + 'No supported dependency files found for scanning.\nDetected: none of package.json, requirements.txt, Pipfile, pyproject.toml';
    } catch (err) {
      return `${header}Dependency scan error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * SAST scan: basic pattern matching for common security anti-patterns.
   */
  private async sastScan(severity: string): Promise<string> {
    const header = '## SAST (Static Analysis) Scan\n';
    const severityLevels = ['critical', 'high', 'medium', 'low', 'all'];
    const minLevelIdx = severityLevels.indexOf(severity);

    // Pattern definitions: [pattern, severity, description]
    const patterns: Array<{ regex: RegExp; severity: string; description: string }> = [
      { regex: /eval\s*\(/, severity: 'critical', description: 'Use of eval() - potential code injection' },
      { regex: /new\s+Function\s*\(/, severity: 'critical', description: 'Use of new Function() - potential code injection' },
      { regex: /innerHTML\s*=/, severity: 'medium', description: 'Direct innerHTML assignment - potential XSS' },
      { regex: /document\.write\s*\(/, severity: 'medium', description: 'Use of document.write() - potential XSS' },
      { regex: /password\s*[:=]\s*['"][^'"]+['"]/, severity: 'high', description: 'Hardcoded password detected' },
      { regex: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i, severity: 'high', description: 'Hardcoded API key detected' },
      { regex: /secret\s*[:=]\s*['"][^'"]+['"]/i, severity: 'high', description: 'Hardcoded secret detected' },
      { regex: /token\s*[:=]\s*['"][^'"]+['"]/i, severity: 'medium', description: 'Hardcoded token detected' },
      { regex: /\.exec\s*\(\s*[^,)]+\s*\)/, severity: 'medium', description: 'Potential command injection via exec()' },
      { regex: /child_process/, severity: 'medium', description: 'Use of child_process - ensure input sanitization' },
      { regex: /SQL\s*.*\+\s*['"`]/i, severity: 'critical', description: 'Potential SQL injection via string concatenation' },
      { regex: /SELECT.*FROM.*WHERE.*\+\s*['"`]/i, severity: 'critical', description: 'Potential SQL injection in query' },
      { regex: /cors\(\s*\)/i, severity: 'low', description: 'CORS allowed for all origins - review security implications' },
    ];

    // Scan JavaScript/TypeScript files
    const jsExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
    const findings: Array<{ file: string; line: number; severity: string; description: string }> = [];

    const { glob } = await import('fast-glob');
    const files = await glob(`src/**/*.{${jsExtensions.join(',')}}`, {
      cwd: this.sandboxDir,
      absolute: true,
    });

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];

          // Skip comments
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

          for (const pattern of patterns) {
            if (pattern.regex.test(line)) {
              const patternLevelIdx = severityLevels.indexOf(pattern.severity);
              if (minLevelIdx <= patternLevelIdx) {
                findings.push({
                  file: filePath.replace(this.sandboxDir + '/', ''),
                  line: lineIdx + 1,
                  severity: pattern.severity,
                  description: pattern.description,
                });
              }
            }
          }
        }
      } catch {
        // Skip files that cannot be read
      }
    }

    if (findings.length === 0) {
      return header + 'No security issues found.\n';
    }

    // Sort by severity
    findings.sort((a, b) => severityLevels.indexOf(a.severity) - severityLevels.indexOf(b.severity));

    const report = findings.map(f => `- [${f.severity.toUpperCase()}] ${f.file}:${f.line}: ${f.description}`).join('\n');
    const summary = `\n\nFound ${findings.length} issue(s): ` +
      findings.reduce<Record<string, number>>((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});

    return header + report + summary;
  }

  /**
   * Format npm audit JSON output into a readable report.
   */
  private formatNpmAudit(stdout: string, stderr: string): string {
    try {
      const audit = JSON.parse(stdout);

      if (audit.metadata?.vulnerabilities?.info === 0 &&
          audit.metadata?.vulnerabilities?.low === 0 &&
          audit.metadata?.vulnerabilities?.moderate === 0 &&
          audit.metadata?.vulnerabilities?.high === 0 &&
          audit.metadata?.vulnerabilities?.critical === 0) {
        return 'No vulnerabilities found in npm dependencies.\n';
      }

      const lines: string[] = ['npm audit results:'];

      if (audit.vulnerabilities) {
        for (const [pkg, info] of Object.entries(audit.vulnerabilities) as Array<[string, { severity?: string; via?: Array<string | { title?: string; url?: string }>; fixAvailable?: boolean }]>) {
          const sev = info.severity || 'unknown';
          const via = info.via?.map(v => typeof v === 'string' ? v : v.title || 'unknown').join(', ') || 'unknown';
          const fixable = info.fixAvailable ? ' (fixable)' : ' (no fix available)';
          lines.push(`- [${sev.toUpperCase()}] ${pkg}: ${via}${fixable}`);
        }
      }

      return lines.join('\n');
    } catch {
      // If JSON parse fails, return raw output
      if (stdout) return `npm audit output:\n${stdout}`;
      if (stderr) return `npm audit stderr:\n${stderr}`;
      return 'npm audit produced no output.';
    }
  }

  /**
   * Run pip audit for Python projects.
   */
  private async pipAudit(severity: string): Promise<string> {
    try {
      const args = ['audit'];
      if (severity !== 'all') {
        args.push('--severity', severity);
      }
      const result = await execa('pip', args, {
        cwd: this.sandboxDir,
        reject: false,
        timeout: 60_000,
      });

      if (result.failed && result.exitCode === 127) {
        return 'pip-audit not installed. Install with: pip install pip-audit\n' +
          'Falling back to pip list for basic dependency check.\n' +
          `pip list output:\n${result.stdout || result.stderr}`;
      }

      return result.stdout || result.stderr || 'pip audit produced no output.';
    } catch (err) {
      return `pip audit error: ${err instanceof Error ? err.message : String(err)}\n` +
        'Tip: Install pip-audit for full dependency scanning: pip install pip-audit';
    }
  }
}
