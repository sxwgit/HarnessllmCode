import { z } from 'zod';
import { execa } from 'execa';
import { BaseTool } from './base.js';

/** Commands that are absolutely forbidden */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+-.*[rf].*[rf].*\s+\//,                                    // rm with both -r and -f flags targeting root
  /\brm\s+--recursive\s+--force/,
  /\brm\s+--force\s+--recursive/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+.*\|\s*.*rm\s+-[a-zA-Z]*f/,       // chained rm -r | rm -f
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+rm\s+-rf\s+\.git/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bformat\s+[A-Z]:/i,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\s+-9\s+1\b/,
  /\bcurl\s+.*\|\s*sh/,
  /\bwget\s+.*\|\s*sh/,
  /\bchmod\s+(-\s*)?777/,
  /\bchown\s+.*\//,
  />\/dev\/sd/,
  /\bdd\s+of=\/dev/,
  /\beval\s+/,
  /\bexec\s+\//,
  /\bsource\s+\/etc\//,
];

/** Commands that are restricted (require sandbox validation) */
const RESTRICTED_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+checkout\s+\.\s*$/,
  /\bgit\s+restore\s+\.\s*$/,
  /\bnpm\s+publish\b/,
  /\bdocker\s+rm\b/,
];

export class BashTool extends BaseTool {
  name = 'bash';
  description = 'Execute a shell command in the target project directory. Use for running tests, installing dependencies, compiling code, and other system commands.';
  inputSchema = z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default 120000)'),
  });

  async execute(input: Record<string, unknown>): Promise<string> {
    const parsed = this.inputSchema.parse(input);
    const timeout = parsed.timeout || 120_000;

    // Security: check for forbidden commands
    const forbidden = this.checkForbidden(parsed.command);
    if (forbidden) {
      throw new Error(`SECURITY: Command blocked - ${forbidden}. This command is not allowed for safety reasons.`);
    }

    // Security: check for restricted commands
    const restricted = this.checkRestricted(parsed.command);
    if (restricted) {
      throw new Error(`SECURITY: Command restricted - ${restricted}. This command requires manual approval.`);
    }

    try {
      const result = await execa(parsed.command, {
        cwd: this.sandboxDir,
        timeout,
        shell: true,
        reject: false,
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });

      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += (output ? '\n' : '') + result.stderr;
      if (result.failed) {
        output += `\n[Exit code: ${result.exitCode}]`;
      }

      return output || '(no output)';
    } catch (err) {
      return `Command execution error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private checkForbidden(command: string): string | null {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(command)) {
        return `matches forbidden pattern "${pattern.source}"`;
      }
    }
    return null;
  }

  private checkRestricted(command: string): string | null {
    for (const pattern of RESTRICTED_PATTERNS) {
      if (pattern.test(command)) {
        return `matches restricted pattern "${pattern.source}"`;
      }
    }
    return null;
  }
}
