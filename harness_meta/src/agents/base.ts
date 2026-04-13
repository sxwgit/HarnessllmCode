import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLMClient } from '../llm/client.js';
import { ToolRegistry } from '../tools/registry.js';
import type { LLMMessage, AgentRole } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AgentRunOptions {
  systemPromptOverride?: string;
  maxRounds?: number;
  onText?: (text: string) => void;
  lightweightContext?: string;
  sprintId?: string;
}

export abstract class BaseAgent {
  protected client: LLMClient;
  protected toolRegistry: ToolRegistry;
  protected role: AgentRole;
  protected systemPrompt: string;

  constructor(role: AgentRole, client: LLMClient, toolRegistry: ToolRegistry) {
    this.role = role;
    this.client = client;
    this.toolRegistry = toolRegistry;
    this.systemPrompt = this.loadPrompt(role);
  }

  async run(userMessage: string, options?: AgentRunOptions): Promise<string> {
    const systemPrompt = options?.systemPromptOverride || this.systemPrompt;
    const effectiveUserMessage = options?.lightweightContext
      ? this.buildLightweightContext(options.lightweightContext, options.sprintId)
      : userMessage;
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: effectiveUserMessage },
    ];

    const tools = this.toolRegistry.toLLMTools();
    const { finalResponse, messages: finalMessages } = await this.client.chatWithTools(
      messages,
      tools,
      async (call) => this.toolRegistry.execute(call),
      options?.onText,
      options?.maxRounds || 120,
    );

    // Extract final text response
    const textParts: string[] = [];
    for (const msg of finalMessages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          textParts.push(msg.content);
        } else {
          for (const block of msg.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            }
          }
        }
      }
    }

    return textParts.join('\n');
  }

  protected truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '\n... (truncated)';
  }

  protected buildLightweightContext(coreContext: string, sprintId?: string): string {
    const header = sprintId
      ? `[AgentContext] role=${this.role} sprintId=${sprintId}`
      : `[AgentContext] role=${this.role}`;
    return `${header}\n${coreContext}`;
  }

  private loadPrompt(role: AgentRole): string {
    const promptMap: Record<AgentRole, string> = {
      planner: 'planner_system.md',
      generator: 'generator_system.md',
      evaluator: 'evaluator_system.md',
    };

    const promptPath = resolve(__dirname, `../../prompts/${promptMap[role]}`);
    try {
      return readFileSync(promptPath, 'utf-8');
    } catch {
      return `You are a ${role} agent. Follow the instructions provided in the user message.`;
    }
  }
}
