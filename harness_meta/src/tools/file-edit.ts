import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseTool } from './base.js';

export class FileEditTool extends BaseTool {
  name = 'file_edit';
  description = 'Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace/indentation) and be unique in the file.';
  inputSchema = z.object({
    path: z.string().describe('Relative path to the file within the target project'),
    old_string: z.string().describe('The exact text to find and replace'),
    new_string: z.string().describe('The replacement text'),
    replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
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
      const content = readFileSync(absPath, 'utf-8');

      if (!content.includes(parsed.old_string)) {
        return `Error: old_string not found in ${parsed.path}`;
      }

      if (!parsed.replace_all) {
        const firstIdx = content.indexOf(parsed.old_string);
        const secondIdx = content.indexOf(parsed.old_string, firstIdx + 1);
        if (secondIdx !== -1) {
          return `Error: old_string is not unique in ${parsed.path}. Found multiple occurrences. Use replace_all: true or provide more context.`;
        }
      }

      const newContent = parsed.replace_all
        ? content.split(parsed.old_string).join(parsed.new_string)
        : content.replace(parsed.old_string, parsed.new_string);

      writeFileSync(absPath, newContent, 'utf-8');

      const occurrences = content.split(parsed.old_string).length - 1;
      return `Successfully replaced ${parsed.replace_all ? occurrences : 1} occurrence(s) in ${parsed.path}`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
