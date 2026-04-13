import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseTool } from './base.js';

export class FileReadTool extends BaseTool {
  name = 'file_read';
  description = 'Read the contents of a file from the target project. Returns file content with line numbers.';
  inputSchema = z.object({
    path: z.string().describe('Relative path to the file within the target project'),
    offset: z.number().optional().describe('Starting line number (1-indexed)'),
    limit: z.number().optional().describe('Maximum number of lines to read'),
  });

  async execute(input: Record<string, unknown>): Promise<string> {
    const parsed = this.inputSchema.parse(input);
    let absPath: string;
    try {
      absPath = this.resolvePath(parsed.path);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      const stat = statSync(absPath);
      if (stat.isDirectory()) {
        return `Error: ${parsed.path} is a directory, not a file`;
      }

      const content = readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');

      const start = (parsed.offset || 1) - 1;
      const end = parsed.limit ? start + parsed.limit : lines.length;
      const selectedLines = lines.slice(start, end);

      return selectedLines
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join('\n');
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
