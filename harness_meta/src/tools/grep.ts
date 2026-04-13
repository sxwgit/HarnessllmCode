import { z } from 'zod';
import { execa } from 'execa';
import { resolve } from 'node:path';
import { BaseTool } from './base.js';

export class GrepTool extends BaseTool {
  name = 'grep';
  description = 'Search file contents using a regular expression pattern in the target project. Returns matching lines with file paths and line numbers.';
  inputSchema = z.object({
    pattern: z.string().describe('Regular expression pattern to search for'),
    path: z.string().optional().describe('Directory or file to search in (relative to target project root)'),
    file_pattern: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts", "*.{js,jsx}")'),
    case_insensitive: z.boolean().optional().describe('Case-insensitive search (default: false)'),
    context: z.number().optional().describe('Number of context lines before and after each match'),
  });

  async execute(input: Record<string, unknown>): Promise<string> {
    const parsed = this.inputSchema.parse(input);
    let searchPath: string;
    try {
      searchPath = parsed.path ? this.resolvePath(parsed.path) : this.sandboxDir;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      const args: string[] = [
        '--line-number',
        '--no-heading',
        '--color=never',
      ];

      if (parsed.case_insensitive) args.push('-i');
      if (parsed.context) args.push('-C', String(parsed.context));
      if (parsed.file_pattern) {
        args.push('--glob', parsed.file_pattern);
      }

      args.push('--max-count', '200');
      args.push(parsed.pattern);
      args.push(searchPath);

      const result = await execa('rg', args, {
        reject: false,
        maxBuffer: 1024 * 1024 * 10,
      });

      if (result.exitCode === 1) {
        return `No matches found for pattern "${parsed.pattern}"`;
      }

      if (result.exitCode === 2) {
        return `Search error: ${result.stderr || 'Unknown error'}`;
      }

      // Make paths relative to sandbox
      const output = (result.stdout || '')
        .split('\n')
        .map(line => line.replace(new RegExp(`^${this.sandboxDir}/`), ''))
        .join('\n');

      return output || `No matches found for pattern "${parsed.pattern}"`;
    } catch (err) {
      // rg might not be installed, fall back to grep
      return `Search tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
