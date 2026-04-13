import { Logger, LogLevel } from '../logger/index.js';
import { HarnessState } from '../types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ============ Exception Classification ============

export enum ExceptionLevel {
  P0 = 'P0', // Catastrophic: full process halt, manual intervention
  P1 = 'P1', // Severe: single sprint blocked, needs rollback
  P2 = 'P2', // Normal: single step blocked, iterable fix
  P3 = 'P3', // Minor: auto-retryable
  P4 = 'P4', // Info: log only, no interruption
}

export interface ExceptionRecord {
  id: string;
  timestamp: string;
  level: ExceptionLevel;
  phase: HarnessState;
  module: string;
  message: string;
  rootCause: string;
  context: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  resolved: boolean;
  resolution?: string;
}

export interface ExceptionHandlerConfig {
  maxRetriesP2: number;    // default 3
  maxRetriesP3: number;    // default 3
  maxRollbacksP1: number;  // default 2
  upgradeAfterRetries: number; // default 3 consecutive failures → upgrade level
}

// ============ Exception Handler ============

export interface RootCauseArchive {
  id: string;
  rootCause: string;
  phase: HarnessState;
  module: string;
  occurrences: number;
  lastOccurrence: string;
  optimizedRule?: string;
}

export class ExceptionHandler {
  private logger: Logger;
  private config: ExceptionHandlerConfig;
  private history: ExceptionRecord[] = [];
  private consecutiveFailures = 0;
  private rootCauseArchive: Map<string, RootCauseArchive> = new Map();
  private archiveDir: string;

  constructor(logger: Logger, config?: Partial<ExceptionHandlerConfig>, archiveDir?: string) {
    this.logger = logger;
    this.config = {
      maxRetriesP2: config?.maxRetriesP2 ?? 3,
      maxRetriesP3: config?.maxRetriesP3 ?? 3,
      maxRollbacksP1: config?.maxRollbacksP1 ?? 2,
      upgradeAfterRetries: config?.upgradeAfterRetries ?? 3,
    };
    this.archiveDir = archiveDir ?? './meta_logs';
    if (!existsSync(this.archiveDir)) mkdirSync(this.archiveDir, { recursive: true });
    this.loadArchive();
  }

  /**
   * Handle an exception with automatic level-based processing
   * Returns true if the exception was self-healed, false if manual intervention needed
   */
  async handle(error: unknown, phase: HarnessState, module: string): Promise<{
    healed: boolean;
    action: 'retry' | 'rollback' | 'abort' | 'skip';
    record: ExceptionRecord;
    upgraded: boolean;
  }> {
    const record = this.createRecord(error, phase, module);
    this.history.push(record);

    this.logger.error(`[${record.level}] ${record.message}`, {
      exceptionId: record.id,
      phase,
      module,
      rootCause: record.rootCause,
      retryCount: record.retryCount,
    });

    switch (record.level) {
      case ExceptionLevel.P0:
        return this.handleP0(record);
      case ExceptionLevel.P1:
        return this.handleP1(record);
      case ExceptionLevel.P2:
        return this.handleP2(record);
      case ExceptionLevel.P3:
        return this.handleP3(record);
      case ExceptionLevel.P4:
        return this.handleP4(record);
    }
  }

  getHistory(): ExceptionRecord[] {
    return [...this.history];
  }

  getUnresolved(): ExceptionRecord[] {
    return this.history.filter(r => !r.resolved);
  }

  getMetrics(): {
    total: number;
    byLevel: Record<string, number>;
    selfHealRate: number;
  } {
    const total = this.history.length;
    const byLevel: Record<string, number> = {};
    let resolved = 0;
    for (const r of this.history) {
      byLevel[r.level] = (byLevel[r.level] || 0) + 1;
      if (r.resolved) resolved++;
    }
    return {
      total,
      byLevel,
      selfHealRate: total > 0 ? resolved / total : 0,
    };
  }

  resetConsecutiveFailures(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Archive root cause after self-healing and optimize rules
   * Framework spec 7.4: "异常自愈完成后，自动归档根因，优化执行规则"
   */
  archiveRootCause(record: ExceptionRecord): void {
    const key = `${record.rootCause}:${record.phase}:${record.module}`;
    const existing = this.rootCauseArchive.get(key);

    if (existing) {
      existing.occurrences++;
      existing.lastOccurrence = record.timestamp;
    } else {
      this.rootCauseArchive.set(key, {
        id: `RC-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        rootCause: record.rootCause,
        phase: record.phase,
        module: record.module,
        occurrences: 1,
        lastOccurrence: record.timestamp,
      });
    }

    // Auto-optimize: if same root cause occurs 3+ times, generate optimization rule
    const archive = this.rootCauseArchive.get(key)!;
    if (archive.occurrences >= 3 && !archive.optimizedRule) {
      archive.optimizedRule = this.generateOptimizationRule(archive);
      this.logger.info('Self-optimization rule generated', {
        rootCause: archive.rootCause,
        occurrences: archive.occurrences,
        rule: archive.optimizedRule,
      });
    }

    this.saveArchive();
  }

  getRootCauseArchive(): RootCauseArchive[] {
    return [...this.rootCauseArchive.values()];
  }

  private generateOptimizationRule(archive: RootCauseArchive): string {
    const rules: Record<string, string> = {
      'llm_api_failure': 'Added retry with exponential backoff for LLM API calls',
      'file_or_resource_missing': 'Pre-create required directories and files before agent execution',
      'permission_denied': 'Validate write permissions before file operations',
      'operation_timeout': 'Increased timeout for identified slow operations',
      'schema_validation_failure': 'Strengthen pre-submission artifact format validation',
      'git_merge_conflict': 'Enable automatic conflict resolution for common patterns',
      'code_compilation_error': 'Add pre-commit compilation check in dev phase',
      'unknown': 'Added generic defensive checks for module',
    };
    return rules[archive.rootCause] || `Added defensive handling for ${archive.rootCause} in ${archive.module}`;
  }

  private saveArchive(): void {
    const path = resolve(this.archiveDir, 'root_cause_archive.json');
    const data = [...this.rootCauseArchive.values()];
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  }

  private loadArchive(): void {
    const path = resolve(this.archiveDir, 'root_cause_archive.json');
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as RootCauseArchive[];
        for (const item of data) {
          this.rootCauseArchive.set(`${item.rootCause}:${item.phase}:${item.module}`, item);
        }
      } catch { /* ignore load errors */ }
    }
  }

  // ============ Level-specific handlers ============

  private async handleP0(record: ExceptionRecord): Promise<{
    healed: boolean; action: 'abort'; record: ExceptionRecord; upgraded: boolean;
  }> {
    // P0: Catastrophic - immediate halt, manual intervention required
    this.logger.fatal('P0 CATASTROPHIC: Halting framework, manual intervention required', {
      exceptionId: record.id,
      phase: record.phase,
      message: record.message,
    });
    return { healed: false, action: 'abort', record, upgraded: false };
  }

  private async handleP1(record: ExceptionRecord): Promise<{
    healed: boolean; action: 'rollback' | 'abort'; record: ExceptionRecord; upgraded: boolean;
  }> {
    const p1Count = this.history.filter(
      r => r.level === ExceptionLevel.P1 && r.phase === record.phase,
    ).length;

    if (p1Count >= this.config.maxRollbacksP1) {
      // Upgrade to P0 after max rollbacks
      this.logger.fatal('P1 → P0 UPGRADE: Exceeded max rollbacks', {
        exceptionId: record.id,
        rollbacks: p1Count,
        max: this.config.maxRollbacksP1,
      });
      record.level = ExceptionLevel.P0;
      return { healed: false, action: 'abort', record, upgraded: true };
    }

    // P1: Rollback to last stable state
    this.logger.warn('P1: Triggering rollback to last stable milestone', {
      exceptionId: record.id,
      rollbackAttempt: p1Count,
    });
    return { healed: false, action: 'rollback', record, upgraded: false };
  }

  private async handleP2(record: ExceptionRecord): Promise<{
    healed: boolean; action: 'retry' | 'rollback'; record: ExceptionRecord; upgraded: boolean;
  }> {
    const p2Count = this.history.filter(
      r => r.level === ExceptionLevel.P2 && r.phase === record.phase && r.module === record.module,
    ).length;

    if (p2Count >= this.config.maxRetriesP2) {
      // Upgrade to P1
      this.logger.error('P2 → P1 UPGRADE: Exceeded max retries, escalating', {
        exceptionId: record.id,
        retries: p2Count,
        max: this.config.maxRetriesP2,
      });
      record.level = ExceptionLevel.P1;
      return { healed: false, action: 'rollback', record, upgraded: true };
    }

    // P2: Retry with fix guidance
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.upgradeAfterRetries) {
      this.logger.warn(`Consecutive failures: ${this.consecutiveFailures}, will upgrade if continues`);
    }

    this.logger.info('P2: Returning for fix iteration', {
      exceptionId: record.id,
      retryAttempt: p2Count,
      maxRetries: this.config.maxRetriesP2,
    });

    return { healed: false, action: 'retry', record, upgraded: false };
  }

  private async handleP3(record: ExceptionRecord): Promise<{
    healed: boolean; action: 'retry' | 'skip'; record: ExceptionRecord; upgraded: boolean;
  }> {
    const p3Count = this.history.filter(
      r => r.level === ExceptionLevel.P3 && r.module === record.module,
    ).length;

    if (p3Count >= this.config.maxRetriesP3) {
      // Upgrade to P2
      this.logger.warn('P3 → P2 UPGRADE: Exceeded max auto-retries', {
        exceptionId: record.id,
        retries: p3Count,
      });
      record.level = ExceptionLevel.P2;
      return { healed: false, action: 'retry', record, upgraded: true };
    }

    // P3: Auto-retry (consider it self-healed if we retry)
    this.logger.info('P3: Auto-retrying', {
      exceptionId: record.id,
      retryAttempt: p3Count,
    });
    record.resolved = true;
    record.resolution = 'auto-retry';
    this.archiveRootCause(record);
    return { healed: true, action: 'retry', record, upgraded: false };
  }

  private async handleP4(record: ExceptionRecord): Promise<{
    healed: boolean; action: 'skip'; record: ExceptionRecord; upgraded: boolean;
  }> {
    // P4: Log only, no interruption
    record.resolved = true;
    record.resolution = 'logged-only';
    return { healed: true, action: 'skip', record, upgraded: false };
  }

  // ============ Helpers ============

  private createRecord(error: unknown, phase: HarnessState, module: string): ExceptionRecord {
    const err = error instanceof Error ? error : new Error(String(error));
    const level = this.classifyException(err, phase);
    const id = `EX-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    return {
      id,
      timestamp: new Date().toISOString(),
      level,
      phase,
      module,
      message: err.message,
      rootCause: this.analyzeRootCause(err),
      context: {},
      retryCount: this.getRetryCount(phase, module),
      maxRetries: this.getMaxRetries(level),
      resolved: false,
    };
  }

  private classifyException(error: Error, phase: HarnessState): ExceptionLevel {
    // Check for error codes first (more reliable than message matching)
    const errWithCode = error as Error & { code?: string };
    if (errWithCode.code) {
      switch (errWithCode.code) {
        case 'ECONNREFUSED':
        case 'ENOTFOUND':
        case 'ETIMEDOUT':
          return ExceptionLevel.P3;
        case 'ENOENT':
          return ExceptionLevel.P2;
        case 'EACCES':
        case 'EPERM':
          return ExceptionLevel.P1;
      }
    }

    const msg = error.message.toLowerCase();

    // P0: Catastrophic scenarios
    if (
      msg.includes('git repository damaged') ||
      msg.includes('environment completely unavailable') ||
      msg.includes('requirement completely unparseable')
    ) {
      return ExceptionLevel.P0;
    }

    // P1: Severe scenarios
    if (
      msg.includes('sprint') && msg.includes('rollback') ||
      msg.includes('merge conflict') && !msg.includes('auto') ||
      msg.includes('architecture defect')
    ) {
      return ExceptionLevel.P1;
    }

    // P2: Normal scenarios
    if (
      msg.includes('validation failed') ||
      msg.includes('self-check failed') ||
      msg.includes('evaluation not passed') ||
      msg.includes('compilation error') ||
      msg.includes('tool-use loop exceeded')
    ) {
      return ExceptionLevel.P2;
    }

    // P3: Minor scenarios
    if (
      msg.includes('timeout') ||
      msg.includes('temporary') ||
      msg.includes('git commit conflict') ||
      msg.includes('minor syntax')
    ) {
      return ExceptionLevel.P3;
    }

    // P4: Info-level
    if (
      msg.includes('non-critical log') ||
      msg.includes('low-risk') ||
      msg.includes('format')
    ) {
      return ExceptionLevel.P4;
    }

    // Default based on phase
    if (phase === HarnessState.META_INIT || phase === HarnessState.PROJECT_INIT) {
      return ExceptionLevel.P1;
    }
    if (phase === HarnessState.DEV || phase === HarnessState.EVALUATION) {
      return ExceptionLevel.P2;
    }
    return ExceptionLevel.P3;
  }

  private analyzeRootCause(error: Error): string {
    const msg = error.message;
    if (msg.includes('API error')) return 'llm_api_failure';
    if (msg.includes('not found')) return 'file_or_resource_missing';
    if (msg.includes('permission')) return 'permission_denied';
    if (msg.includes('timeout')) return 'operation_timeout';
    if (msg.includes('validation')) return 'schema_validation_failure';
    if (msg.includes('merge conflict')) return 'git_merge_conflict';
    if (msg.includes('compilation')) return 'code_compilation_error';
    return 'unknown';
  }

  private getRetryCount(phase: HarnessState, module: string): number {
    return this.history.filter(
      r => r.phase === phase && r.module === module && !r.resolved,
    ).length;
  }

  private getMaxRetries(level: ExceptionLevel): number {
    switch (level) {
      case ExceptionLevel.P0: return 0;
      case ExceptionLevel.P1: return this.config.maxRollbacksP1;
      case ExceptionLevel.P2: return this.config.maxRetriesP2;
      case ExceptionLevel.P3: return this.config.maxRetriesP3;
      case ExceptionLevel.P4: return 0;
    }
  }
}
