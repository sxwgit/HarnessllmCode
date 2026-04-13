import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  state?: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
  agent?: string;
  sprintId?: string;
  errorCode?: string;
  operator?: string;
  keyParams?: Record<string, unknown>;
}

export class Logger {
  private logDir: string;
  private logFile: string;
  private module: string;
  private minLevel: LogLevel;

  private static readonly LEVEL_ORDER: LogLevel[] = [
    LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR, LogLevel.FATAL,
  ];

  constructor(logDir: string, module: string, minLevel: LogLevel = LogLevel.DEBUG) {
    this.logDir = logDir;
    this.module = module;
    this.minLevel = minLevel;

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const date = new Date().toISOString().split('T')[0];
    this.logFile = resolve(logDir, `${date}.jsonl`);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, data);
  }

  fatal(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.FATAL, message, data);
  }

  /** Create a child logger for a submodule */
  child(subModule: string): Logger {
    return new Logger(this.logDir, `${this.module}:${subModule}`, this.minLevel);
  }

  /** Read all log entries for a given date */
  static readLogs(logDir: string, date?: string): LogEntry[] {
    if (!existsSync(logDir)) return [];

    const files = date
      ? [resolve(logDir, `${date}.jsonl`)]
      : readdirSync(logDir)
          .filter(f => f.endsWith('.jsonl'))
          .sort()
          .map(f => resolve(logDir, f));

    const entries: LogEntry[] = [];
    for (const file of files) {
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
    }
    return entries;
  }

  /** Count log entries by level */
  static countByLevel(entries: LogEntry[]): Record<LogLevel, number> {
    const counts: Record<string, number> = {
      [LogLevel.DEBUG]: 0, [LogLevel.INFO]: 0, [LogLevel.WARN]: 0,
      [LogLevel.ERROR]: 0, [LogLevel.FATAL]: 0,
    };
    for (const entry of entries) {
      counts[entry.level] = (counts[entry.level] || 0) + 1;
    }
    return counts as Record<LogLevel, number>;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (Logger.LEVEL_ORDER.indexOf(level) < Logger.LEVEL_ORDER.indexOf(this.minLevel)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
    };

    if (data && Object.keys(data).length > 0) {
      entry.data = data;
      // Populate dedicated fields from data
      if (data.state !== undefined) entry.state = String(data.state);
      if (data.errorCode !== undefined) entry.errorCode = String(data.errorCode);
      if (data.operator !== undefined) entry.operator = String(data.operator);
      if (data.sprintId !== undefined) entry.sprintId = String(data.sprintId);
      if (data.agent !== undefined) entry.agent = String(data.agent);
      if (data.duration_ms !== undefined) entry.duration_ms = Number(data.duration_ms);
    }

    const line = JSON.stringify(entry) + '\n';
    // Ensure log directory exists (may have been deleted by rollback/git operations)
    const logDir = dirname(this.logFile);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    appendFileSync(this.logFile, line, 'utf-8');
  }
}

/** Dual logger manager - creates independent loggers for meta and project */
export class DualLogger {
  private metaLogDir: string;
  private projectLogDir: string;

  constructor(metaLogDir: string, projectLogDir: string) {
    this.metaLogDir = metaLogDir;
    this.projectLogDir = projectLogDir;
  }

  /** Logger for meta-program operations */
  meta(module: string): Logger {
    return new Logger(this.metaLogDir, module);
  }

  /** Logger for target-project build operations */
  project(module: string): Logger {
    return new Logger(this.projectLogDir, module);
  }
}
