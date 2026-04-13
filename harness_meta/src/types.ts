import { z } from 'zod';

// ============ FSM States ============
export enum HarnessState {
  META_INIT = 'META_INIT',
  PROJECT_INIT = 'PROJECT_INIT',
  REQUIREMENT_PARSE = 'REQUIREMENT_PARSE',
  PLANNING = 'PLANNING',
  SPRINT_DISPATCH = 'SPRINT_DISPATCH',
  SPRINT_NEGOTIATION = 'SPRINT_NEGOTIATION',
  DEV = 'DEV',
  PRE_EVALUATION = 'PRE_EVALUATION',
  EVALUATION = 'EVALUATION',
  SPRINT_MERGE = 'SPRINT_MERGE',
  FINAL_ACCEPTANCE = 'FINAL_ACCEPTANCE',
  RELEASE = 'RELEASE',
  FINISHED = 'FINISHED',
  EXCEPTION_HANDLE = 'EXCEPTION_HANDLE',
  MANUAL_INTERVENTION = 'MANUAL_INTERVENTION',
}

// ============ LLM Types ============
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  id: string;
  content: LLMContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ============ Tool Types ============
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
}

// ============ Agent Types ============
export type AgentRole = 'planner' | 'generator' | 'evaluator';

export interface AgentConfig {
  role: AgentRole;
  systemPrompt: string;
  maxTokens?: number;
}

// ============ Sprint Types ============
export interface SprintInfo {
  id: string;
  name: string;
  priority: number;
  goals: string[];
  deliverables: string[];
  dependencies: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

// ============ State Persistence ============
export interface HarnessMetaState {
  currentState: HarnessState;
  previousState: HarnessState | null;
  startedAt: string;
  updatedAt: string;
  errorCount: number;
  currentSprintId: string | null;
  completedSprints: string[];
  metrics: {
    totalTokensUsed: number;
    totalIterations: number;
    exceptionsHandled: number;
  };
}

export interface ProjectState {
  currentState: HarnessState;
  previousState: HarnessState | null;
  version: number;
  initialized: boolean;
  sprints: SprintInfo[];
  currentSprintId: string | null;
  completedSprints: string[];
  milestoneTags: string[];
  updatedAt: string;
}

// ============ Evaluation Types ============
export interface EvaluationScore {
  dimension: string;
  weight: number;
  score: number;
  maxScore: number;
  notes: string;
}

export interface EvaluationResult {
  passed: boolean;
  scores: EvaluationScore[];
  weightedAverage: number;
  issues: EvaluationIssue[];
}

export interface EvaluationIssue {
  id: string;
  severity: 'blocking' | 'critical' | 'normal' | 'minor';
  file?: string;
  line?: number;
  description: string;
  rootCause: string;
  fixSuggestion: string;
}
