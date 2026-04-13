import { z } from 'zod';
import { resolve } from 'node:path';
import type { ToolDefinition, ToolResult, ToolCall } from '../types.js';
import type { IsolationMonitor } from '../isolation/monitor.js';

export interface Tool extends ToolDefinition {
  execute(input: Record<string, unknown>): Promise<string>;
  toLLMTool(): { name: string; description: string; input_schema: Record<string, unknown> };
}

export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract inputSchema: z.ZodType<unknown>;

  protected sandboxDir: string;
  protected isolationMonitor: IsolationMonitor | null = null;

  constructor(sandboxDir: string) {
    this.sandboxDir = sandboxDir;
  }

  /** Set the isolation monitor for sandbox enforcement */
  setIsolationMonitor(monitor: IsolationMonitor): void {
    this.isolationMonitor = monitor;
  }

  abstract execute(input: Record<string, unknown>): Promise<string>;

  toLLMTool(): { name: string; description: string; input_schema: Record<string, unknown> } {
    const schema = this.inputSchema as z.ZodObject<Record<string, z.ZodType<unknown>>>;
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: this.zodToJsonSchema(schema),
        required: this.getRequiredFields(schema),
      },
    };
  }

  protected resolvePath(filePath: string): string {
    if (this.isolationMonitor) {
      return this.isolationMonitor.validateTargetPath(filePath);
    }
    // Fallback: basic path check
    const abs = resolve(this.sandboxDir, filePath);
    if (!abs.startsWith(this.sandboxDir)) {
      throw new Error(`Path traversal detected: ${filePath} is outside sandbox`);
    }
    return abs;
  }

  private zodToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
    // Basic Zod to JSON Schema conversion
    if (schema instanceof z.ZodString) {
      return { type: 'string' };
    }
    if (schema instanceof z.ZodNumber) {
      return { type: 'number' };
    }
    if (schema instanceof z.ZodBoolean) {
      return { type: 'boolean' };
    }
    if (schema instanceof z.ZodArray) {
      return { type: 'array', items: this.zodToJsonSchema(schema.element) };
    }
    if (schema instanceof z.ZodOptional) {
      return this.zodToJsonSchema(schema.unwrap());
    }
    if (schema instanceof z.ZodDefault) {
      return this.zodToJsonSchema(schema.removeDefault());
    }
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodType<unknown>>;
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = this.zodToJsonSchema(value);
      }
      return { type: 'object', properties };
    }
    return {};
  }

  private getRequiredFields(schema: z.ZodType<unknown>): string[] {
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodType<unknown>>;
      return Object.entries(shape)
        .filter(([, v]) => !(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault))
        .map(([k]) => k);
    }
    return [];
  }
}
