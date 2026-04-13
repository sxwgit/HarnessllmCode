import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { BaseTool } from './base.js';

export class FileWriteTool extends BaseTool {
  name = 'file_write';
  description = 'Write content to a file in the target project. Creates the file and any necessary parent directories. Overwrites existing files.';
  inputSchema = z.object({
    path: z.string().describe('Relative path to the file within the target project'),
    content: z.string().describe('The content to write to the file'),
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
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, parsed.content, 'utf-8');
      return `Successfully wrote ${parsed.content.length} bytes to ${parsed.path}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
