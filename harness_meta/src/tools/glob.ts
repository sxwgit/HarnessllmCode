import { z } from 'zod';
import fg from 'fast-glob';
import { resolve } from 'node:path';
import { BaseTool } from './base.js';

export class GlobTool extends BaseTool {
  name = 'glob';
  description = 'Find files matching a glob pattern in the target project. Returns matching file paths sorted by modification time.';
  inputSchema = z.object({
    pattern: z.string().describe('Glob pattern to match files (e.g., "**/*.ts", "src/**/*.js")'),
    path: z.string().optional().describe('Directory to search in (relative to target project root)'),
  });

  async execute(input: Record<string, unknown>): Promise<string> {
    const parsed = this.inputSchema.parse(input);
    let searchDir: string;
    try {
      searchDir = parsed.path ? this.resolvePath(parsed.path) : this.sandboxDir;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      const entries = await fg(parsed.pattern, {
        cwd: searchDir,
        absolute: false,
        onlyFiles: true,
        ignore: ['node_modules', '.git', 'dist'],
      });

      if (entries.length === 0) {
        return `No files matching pattern "${parsed.pattern}" found`;
      }

      return entries.join('\n');
    } catch (err) {
      return `Error searching files: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
