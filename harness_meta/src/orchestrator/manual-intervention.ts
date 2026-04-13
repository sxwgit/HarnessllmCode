import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { Logger } from '../logger/index.js';
import { HarnessState } from '../types.js';

export interface ManualInterventionRecord {
  id: string;
  timestamp: string;
  trigger: string;
  phase: HarnessState;
  errorReport: string;
  currentState: string;
  action: 'pause' | 'resume' | 'abort';
  operator?: string;
  notes?: string;
  gitCommitHash?: string;
}

/**
 * Manual Intervention Audit
 *
 * When the framework reaches a state it cannot self-heal,
 * it pauses and logs the intervention request with full context.
 * All manual operations must be recorded with git audit trail.
 */
export class ManualIntervention {
  private auditLogPath: string;
  private logger: Logger;
  private records: ManualInterventionRecord[] = [];
  private paused = false;
  private targetDir: string;

  constructor(metaDir: string, logger: Logger, targetDir?: string) {
    const logDir = resolve(metaDir, 'audit');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    this.auditLogPath = resolve(logDir, 'manual_interventions.jsonl');
    this.logger = logger;
    this.targetDir = targetDir ?? resolve(metaDir, '..', 'target_project');
  }

  /**
   * Request manual intervention - pauses the framework
   */
  async requestIntervention(
    trigger: string,
    phase: HarnessState,
    errorReport: string,
    currentState: string,
  ): Promise<ManualInterventionRecord> {
    this.paused = true;

    const record: ManualInterventionRecord = {
      id: `MI-${Date.now()}`,
      timestamp: new Date().toISOString(),
      trigger,
      phase,
      errorReport,
      currentState,
      action: 'pause',
    };

    this.records.push(record);
    this.persistRecord(record);

    // Create git audit commit in target project (framework spec: 人工操作必须生成审计日志+Git标注提交)
    await this.createAuditCommit(record);

    this.logger.fatal('MANUAL INTERVENTION REQUIRED', {
      interventionId: record.id,
      trigger,
      phase,
    });

    // Output detailed report to console
    console.error(`
╔══════════════════════════════════════════════════════════════╗
║              MANUAL INTERVENTION REQUIRED                    ║
╠══════════════════════════════════════════════════════════════╣
║ ID: ${record.id}
║ Time: ${record.timestamp}
║ Phase: ${phase}
║ Trigger: ${trigger}
╠══════════════════════════════════════════════════════════════╣
║ Error Report:
║ ${errorReport.substring(0, 500)}
╠══════════════════════════════════════════════════════════════╣
║ Current State:
║ ${currentState.substring(0, 500)}
╠══════════════════════════════════════════════════════════════╣
║ To resolve: review the error, fix in target_project, then
║ restart the framework. The framework will resume from the
║ last checkpoint.
╚══════════════════════════════════════════════════════════════╝
`);

    return record;
  }

  /**
   * Record a manual fix that was applied
   */
  recordManualFix(
    interventionId: string,
    operator: string,
    notes: string,
    gitCommitHash?: string,
  ): void {
    const record = this.records.find(r => r.id === interventionId);
    if (record) {
      record.operator = operator;
      record.notes = notes;
      record.gitCommitHash = gitCommitHash;
      record.action = 'resume';
      this.persistRecord(record);
    }

    this.logger.info('Manual fix recorded', {
      interventionId,
      operator,
      gitCommitHash,
    });
  }

  isPaused(): boolean {
    return this.paused;
  }

  resume(): void {
    this.paused = false;
    this.logger.info('Framework resumed after manual intervention');
  }

  getRecords(): ManualInterventionRecord[] {
    return [...this.records];
  }

  private persistRecord(record: ManualInterventionRecord): void {
    const line = JSON.stringify(record) + '\n';
    appendFileSync(this.auditLogPath, line, 'utf-8');
  }

  /**
   * Create a git commit in target project to record manual intervention
   * Framework spec: "人工操作必须生成审计日志+Git标注提交"
   */
  private async createAuditCommit(record: ManualInterventionRecord): Promise<void> {
    try {
      // Write audit marker file
      const auditPath = resolve(this.targetDir, 'docs', 'sprint', `manual_intervention_${record.id}.md`);
      const content = `# Manual Intervention Record
- ID: ${record.id}
- Timestamp: ${record.timestamp}
- Phase: ${record.phase}
- Trigger: ${record.trigger}
- Error: ${(record.errorReport || '').substring(0, 1000)}
- Status: ${record.action}
`;
      writeFileSync(auditPath, content, 'utf-8');

      // Git add + commit with manual-fix type
      await execa('git', ['add', auditPath], { cwd: this.targetDir, reject: false });
      await execa('git', ['commit', '-m', `manual-fix(sprint-${record.phase}): manual intervention ${record.id} — ${record.trigger.substring(0, 80)}`], {
        cwd: this.targetDir, reject: false, timeout: 30_000,
      });
      record.gitCommitHash = 'audit-commit-created';
    } catch (err) {
      this.logger.warn('Failed to create audit git commit', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
