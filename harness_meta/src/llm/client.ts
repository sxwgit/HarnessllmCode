import type { LLMMessage, LLMContentBlock, LLMResponse, LLMTool, ToolCall, ToolResult } from '../types.js';

export class LLMClient {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private maxContextTokens = 180000;

  constructor(config: { baseURL: string; apiKey: string; model: string; maxTokens: number; temperature: number }) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
  }

  private maxRetries = 3;
  private retryDelayMs = 1000;

  /**
   * Non-streaming chat completion with retry for transient errors
   */
  async chat(messages: LLMMessage[], tools?: LLMTool[]): Promise<LLMResponse> {
    // Extract system messages into the top-level 'system' field (Anthropic API format)
    const systemMessages: string[] = [];
    const nonSystemMessages: LLMMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text) systemMessages.push(text);
      } else {
        nonSystemMessages.push(msg);
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: this.normalizeMessages(nonSystemMessages),
    };
    if (systemMessages.length > 0) {
      body.system = systemMessages.join('\n\n');
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    const res = await this.fetchWithRetry(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`LLM API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    if (data.usage) {
      // Support multiple API-compatible field names (Anthropic, MiniMax, OpenAI formats)
      this.totalInputTokens += data.usage.input_tokens || data.usage.prompt_tokens || 0;
      this.totalOutputTokens += data.usage.output_tokens || data.usage.completion_tokens || 0;
    }

    return {
      id: data.id,
      content: data.content || [],
      stop_reason: data.stop_reason || null,
      usage: data.usage || { input_tokens: 0, output_tokens: 0 },
    };
  }

  /**
   * Tool-Use Loop: automatically handle tool calls until the model stops
   */
  async chatWithTools(
    messages: LLMMessage[],
    tools: LLMTool[],
    toolExecutor: (call: ToolCall) => Promise<ToolResult>,
    onText?: (text: string) => void,
    maxRounds = 50,
  ): Promise<{ messages: LLMMessage[]; finalResponse: LLMResponse }> {
    let currentMessages = [...messages];

    for (let round = 0; round < maxRounds; round++) {
      currentMessages = this.trimMessages(currentMessages, 8000);
      const response = await this.chat(currentMessages, tools);

      // Diagnostic: log response summary
      const contentTypes = response.content.map(b => b.type).join(', ');
      console.log(`[LLM-DEBUG] round=${round} stop_reason=${response.stop_reason} content_types=[${contentTypes}] msg_count=${currentMessages.length}`);

      // Extract text content
      const textBlocks = response.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
      for (const tb of textBlocks) {
        if (onText && tb.text) onText(tb.text);
      }

      // Handle thinking blocks: strip them from content before sending back to API
      // (some models return thinking blocks that are not accepted in subsequent messages)
      const cleanContent = response.content.filter(b => b.type !== 'thinking');

      // Check for tool_use blocks — execute them even when stop_reason is 'max_tokens'
      // (model may have generated partial tool calls before hitting the limit)
      const toolUseBlocks = response.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        console.log(`[LLM-DEBUG] Executing ${toolUseBlocks.length} tool calls: ${toolUseBlocks.map(t => t.name).join(', ')}`);

        // Add assistant message with tool calls (strip thinking blocks to avoid API rejection)
        currentMessages.push({
          role: 'assistant',
          content: cleanContent.length > 0 ? cleanContent : response.content,
        });

        // Execute each tool call
        const toolResults: LLMContentBlock[] = [];
        for (const toolCall of toolUseBlocks) {
          try {
            const result = await toolExecutor({
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.input,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: result.tool_use_id,
              content: result.content,
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: `Error executing tool ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        // Add tool results as user message
        currentMessages.push({
          role: 'user',
          content: toolResults,
        });

        // If stop_reason was max_tokens, the model may have more to say — continue the loop
        if (response.stop_reason === 'max_tokens') {
          console.log(`[LLM-DEBUG] max_tokens hit with tool_use, continuing loop`);
          continue;
        }
        // stop_reason === 'tool_use' — continue the loop normally
        continue;
      }

      // No tool_use blocks — check if model is done
      const isTerminal = ['end_turn', 'max_tokens', 'stop', 'stop_sequence'].includes(response.stop_reason || '');
      if (isTerminal) {
        return { messages: currentMessages, finalResponse: response };
      }

      // Unknown stop_reason without tool_use — treat as terminal to avoid infinite loop
      console.log(`[LLM-DEBUG] Unknown stop_reason "${response.stop_reason}" without tool_use, treating as terminal`);
      return { messages: currentMessages, finalResponse: response };
    }

    throw new Error('Tool-use loop exceeded maximum rounds');
  }

  /**
   * Simple text generation (no tools)
   */
  async generate(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'user', content: userMessage },
    ];

    const response = await this.chat(messages);
    const textBlocks = response.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n');
  }

  /**
   * Generate with system prompt
   */
  async generateWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const response = await this.chat(messages);
    const textBlocks = response.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n');
  }

  /**
   * Estimate token count for a list of messages.
   * Rough heuristic: 1 token per 4 chars for English, 1 token per 1.5 chars for CJK.
   */
  estimateTokens(messages: LLMMessage[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && 'text' in block) {
            totalChars += (block as { type: 'text'; text: string }).text.length;
          } else if (block.type === 'tool_result' && 'content' in block) {
            const resultContent = (block as { type: 'tool_result'; content: string | unknown[] }).content;
            if (typeof resultContent === 'string') {
              totalChars += resultContent.length;
            } else if (Array.isArray(resultContent)) {
              for (const item of resultContent) {
                if (typeof item === 'string') totalChars += item.length;
                else if (item && typeof item === 'object' && 'text' in item) totalChars += String((item as { text: unknown }).text).length;
              }
            }
          }
        }
      }
      // Count role overhead
      totalChars += msg.role.length;
    }

    // Estimate CJK character ratio and compute tokens
    const cjkPattern = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
    let cjkCount = 0;
    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      cjkCount += (text.match(cjkPattern) || []).length;
    }
    const nonCjkChars = totalChars - cjkCount;
    const estimatedTokens = Math.ceil(cjkCount / 1.5) + Math.ceil(nonCjkChars / 4);
    return estimatedTokens;
  }

  /**
   * Trim messages to fit within the context window, keeping system messages
   * and the most recent messages. Reserve tokens are subtracted from the budget.
   */
  trimMessages(messages: LLMMessage[], reserveTokens: number): LLMMessage[] {
    const budget = this.maxContextTokens - reserveTokens;
    const currentTokens = this.estimateTokens(messages);
    if (currentTokens <= budget) {
      return messages;
    }

    // Separate system messages and non-system messages
    const systemMessages: LLMMessage[] = [];
    const nonSystemMessages: LLMMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        nonSystemMessages.push(msg);
      }
    }

    const systemTokens = this.estimateTokens(systemMessages);
    const availableForNonSystem = budget - systemTokens;
    if (availableForNonSystem <= 0) {
      // Even system messages exceed budget; return only system messages
      return systemMessages;
    }

    // Keep dropping oldest non-system messages until we fit
    const kept: LLMMessage[] = [];
    let usedTokens = 0;
    // Iterate from newest to oldest
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens([nonSystemMessages[i]]);
      if (usedTokens + msgTokens > availableForNonSystem) {
        break;
      }
      kept.unshift(nonSystemMessages[i]);
      usedTokens += msgTokens;
    }

    return [...systemMessages, ...kept];
  }

  getTokenUsage() {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      total: this.totalInputTokens + this.totalOutputTokens,
    };
  }

  /**
   * Fetch with automatic retry for transient errors (429, 503, 500) and timeout.
   * Network-level errors (TypeError: fetch failed) use longer delays with jitter.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | null = null;
    const timeoutMs = 300_000; // 5 minute timeout per request
    const networkErrorBaseDelay = 3000; // Longer base delay for network-level errors

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timer);
        if (res.status === 429 || res.status === 503 || res.status === 500) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
          lastError = new Error(`LLM API transient error ${res.status}, retry ${attempt + 1}/${this.maxRetries}`);
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error(`LLM API request timed out after ${timeoutMs / 1000}s`);
        }
        if (attempt < this.maxRetries - 1) {
          const isNetworkError = err instanceof TypeError || (err instanceof Error && err.message.includes('fetch failed'));
          const baseDelay = isNetworkError ? networkErrorBaseDelay : this.retryDelayMs;
          // Add jitter (0.5x to 1.5x) to avoid thundering herd on shared APIs
          const jitter = 0.5 + Math.random();
          const delay = Math.round(baseDelay * Math.pow(2, attempt) * jitter);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError || new Error('LLM API request failed after retries');
  }

  private normalizeMessages(messages: LLMMessage[]): LLMMessage[] {
    // Filter out empty messages
    const result: LLMMessage[] = [];
    for (const msg of messages) {
      if (typeof msg.content === 'string' && msg.content.trim() === '') continue;
      result.push(msg);
    }

    // Anthropic API requires first message to be user role
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({ role: 'user', content: 'Please proceed.' });
    }

    return result;
  }
}
