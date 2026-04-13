import type { ToolCall, ToolResult } from '../types.js';
import type { Tool } from './base.js';
import { BashTool } from './bash.js';
import { FileReadTool } from './file-read.js';
import { FileWriteTool } from './file-write.js';
import { FileEditTool } from './file-edit.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { SecurityScanTool } from './security-scan.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  static createDefault(sandboxDir: string): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(new BashTool(sandboxDir));
    registry.register(new FileReadTool(sandboxDir));
    registry.register(new FileWriteTool(sandboxDir));
    registry.register(new FileEditTool(sandboxDir));
    registry.register(new GlobTool(sandboxDir));
    registry.register(new GrepTool(sandboxDir));
    registry.register(new SecurityScanTool(sandboxDir));
    return registry;
  }

  /** Inject isolation monitor into all registered tools */
  setIsolationMonitor(monitor: { validateTargetPath: (p: string) => string }): void {
    for (const tool of this.tools.values()) {
      if ('setIsolationMonitor' in tool) {
        (tool as { setIsolationMonitor: (m: unknown) => void }).setIsolationMonitor(monitor);
      }
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  toLLMTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
    return this.getAllTools().map(t => t.toLLMTool());
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        tool_use_id: call.id,
        content: `Unknown tool: ${call.name}`,
        isError: true,
      };
    }

    try {
      const content = await tool.execute(call.input);
      return {
        tool_use_id: call.id,
        content,
      };
    } catch (err) {
      return {
        tool_use_id: call.id,
        content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
