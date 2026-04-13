import { Logger } from '../logger/index.js';
import { GitManager } from '../git/manager.js';

export enum RollbackLevel {
  SPRINT = 'sprint',     // Single sprint rollback
  ARCHITECTURE = 'architecture',  // Architecture-level rollback
  CATASTROPHIC = 'catastrophic',  // Full rollback to plan-complete
}

export interface RollbackRecord {
  id: string;
  timestamp: string;
  level: RollbackLevel;
  trigger: string;
  sprintId?: string;
  fromTag?: string;
  toTag?: string;
  commitsReverted: number;
  success: boolean;
  auditLog: string;
}

/**
 * Rollback Manager
 *
 * Implements the three-level rollback strategy from framework spec:
 * - Sprint level: revert current sprint branch to pre-sprint state
 * - Architecture level: revert to last stable architecture milestone
 * - Catastrophic: revert everything back to v0.1.0-plan-complete
 *
 * All rollbacks use git revert only (never git reset --hard)
 * All operations go through GitManager for isolation enforcement (G-05)
 * Each revert generates an independent Git commit for full traceability (S-02)
 */
export class RollbackManager {
  private git: GitManager;
  private targetDir: string;
  private logger: Logger;
  private history: RollbackRecord[] = [];

  constructor(git: GitManager, targetDir: string, logger: Logger) {
    this.git = git;
    this.targetDir = targetDir;
    this.logger = logger;
  }

  /**
   * Execute a rollback at the specified level
   */
  async execute(
    level: RollbackLevel,
    trigger: string,
    sprintId?: string,
  ): Promise<RollbackRecord> {
    this.logger.warn(`Initiating ${level} rollback`, { trigger, sprintId });

    const record: RollbackRecord = {
      id: `RB-${Date.now()}`,
      timestamp: new Date().toISOString(),
      level,
      trigger,
      sprintId,
      commitsReverted: 0,
      success: false,
      auditLog: '',
    };

    try {
      switch (level) {
        case RollbackLevel.SPRINT:
          await this.sprintRollback(sprintId!, record);
          break;
        case RollbackLevel.ARCHITECTURE:
          await this.architectureRollback(record);
          break;
        case RollbackLevel.CATASTROPHIC:
          await this.catastrophicRollback(record);
          break;
      }
      record.success = true;
    } catch (err) {
      record.success = false;
      record.auditLog += `\nERROR: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.error('Rollback failed', {
        rollbackId: record.id,
        level,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.history.push(record);
    return record;
  }

  getHistory(): RollbackRecord[] {
    return [...this.history];
  }

  // ============ Private Rollback Implementations ============

  private async sprintRollback(sprintId: string, record: RollbackRecord): Promise<void> {
    const branchName = `sprint/${sprintId}`;

    // 1. Checkout the sprint branch
    await this.git.checkout(branchName);

    // 2. Find the base commit (where the branch diverged from dev)
    const mergeBase = await this.getMergeBase(branchName, 'dev');
    record.fromTag = branchName;

    // 3. Get commits to revert
    const commitsToRevert = await this.getCommitsInRange(mergeBase, 'HEAD');
    record.commitsReverted = commitsToRevert.length;

    // 4. Revert each commit in reverse order — each revert gets its own commit (S-02)
    let revertedCount = 0;
    let conflictCount = 0;
    for (const commit of commitsToRevert.reverse()) {
      try {
        await this.revertCommit(commit);
        // Each revert is committed individually for full traceability
        await this.git.commitRevert(`sprint-${sprintId}: revert ${commit.substring(0, 8)}`);
        revertedCount++;
      } catch (err) {
        conflictCount++;
        record.auditLog += `\nConflict reverting ${commit}: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.warn('Revert conflict, aborting remaining reverts', { commit });
        // Stop on first conflict rather than silently continuing
        break;
      }
    }

    if (conflictCount > 0) {
      record.success = false;
      record.auditLog += `\nSprint ${sprintId} rollback incomplete: ${revertedCount}/${record.commitsReverted} reverted, ${conflictCount} conflicts`;
      throw new Error(`Sprint rollback had ${conflictCount} conflict(s), only ${revertedCount}/${record.commitsReverted} commits reverted`);
    }

    // M-03: Batch revert commit cleanup — create a summary tag marking the rollback point
    // and record the full list of reverted commits in the audit log.
    // Design note: All rollbacks use git revert only (never git reset --hard).
    // Each revert generates an independent commit for full traceability (S-02).
    // After the batch, we tag the rollback boundary for easy identification.
    const rollbackTag = `rollback-${sprintId}-${Date.now()}`;
    try {
      await this.git.createTag(rollbackTag);
      record.auditLog += `\nRollback tag created: ${rollbackTag}`;
    } catch {
      this.logger.warn('Failed to create rollback tag', { tag: rollbackTag });
    }

    // Record the full list of reverted commits in the audit log for traceability
    const revertedCommitsList = commitsToRevert.map(c => `  - ${c}`).join('\n');
    record.auditLog += `\nFull list of reverted commits (${revertedCount}):\n${revertedCommitsList}`;

    record.auditLog += `\nSprint ${sprintId} rolled back. ${revertedCount} commits reverted (individual revert commits, tagged at ${rollbackTag}).`;
    record.toTag = `pre-${sprintId}-rollback`;

    this.logger.info('Sprint rollback completed', {
      sprintId,
      commitsReverted: record.commitsReverted,
    });
  }

  private async architectureRollback(record: RollbackRecord): Promise<void> {
    // Find the last stable architecture milestone tag
    const stableTag = await this.findLastStableTag();
    if (!stableTag) {
      throw new Error('No stable milestone tag found for architecture rollback');
    }

    record.toTag = stableTag;

    // Revert all commits from the stable tag to HEAD on dev branch
    await this.git.checkout('dev');
    const commitsToRevert = await this.getCommitsInRange(stableTag, 'HEAD');
    record.commitsReverted = commitsToRevert.length;

    let revertedCount = 0;
    for (const commit of commitsToRevert.reverse()) {
      try {
        await this.revertCommit(commit);
        // Each revert gets its own commit for traceability (S-02)
        await this.git.commitRevert(`architecture: revert ${commit.substring(0, 8)}`);
        revertedCount++;
      } catch {
        record.auditLog += `\nConflict reverting ${commit}`;
        break; // Stop on conflict
      }
    }

    if (revertedCount < record.commitsReverted) {
      throw new Error(`Architecture rollback incomplete: ${revertedCount}/${record.commitsReverted} reverted`);
    }

    // M-03: Create rollback summary tag and record full commit list in audit log
    const rollbackTag = `rollback-architecture-${Date.now()}`;
    try {
      await this.git.createTag(rollbackTag);
      record.auditLog += `\nRollback tag created: ${rollbackTag}`;
    } catch {
      this.logger.warn('Failed to create rollback tag', { tag: rollbackTag });
    }

    const revertedCommitsList = commitsToRevert.map(c => `  - ${c}`).join('\n');
    record.auditLog += `\nFull list of reverted commits (${revertedCount}):\n${revertedCommitsList}`;

    record.auditLog += `\nArchitecture rollback to ${stableTag}. ${revertedCount} commits reverted (individual revert commits, tagged at ${rollbackTag}).`;
  }

  private async catastrophicRollback(record: RollbackRecord): Promise<void> {
    // Revert to the plan-complete milestone
    const targetTag = 'v0.1.0-plan-complete';
    record.toTag = targetTag;

    await this.git.checkout('dev');

    const commitsToRevert = await this.getCommitsInRange(targetTag, 'HEAD');
    record.commitsReverted = commitsToRevert.length;

    let revertedCount = 0;
    for (const commit of commitsToRevert.reverse()) {
      try {
        await this.revertCommit(commit);
        // Each revert gets its own commit for traceability (S-02)
        await this.git.commitRevert(`catastrophic: revert ${commit.substring(0, 8)}`);
        revertedCount++;
      } catch {
        record.auditLog += `\nConflict reverting ${commit}`;
        break; // Stop on conflict
      }
    }

    if (revertedCount < record.commitsReverted) {
      throw new Error(`Catastrophic rollback incomplete: ${revertedCount}/${record.commitsReverted} reverted`);
    }

    // M-03: Create rollback summary tag and record full commit list in audit log
    const rollbackTag = `rollback-catastrophic-${Date.now()}`;
    try {
      await this.git.createTag(rollbackTag);
      record.auditLog += `\nRollback tag created: ${rollbackTag}`;
    } catch {
      this.logger.warn('Failed to create rollback tag', { tag: rollbackTag });
    }

    const revertedCommitsList = commitsToRevert.map(c => `  - ${c}`).join('\n');
    record.auditLog += `\nFull list of reverted commits (${revertedCount}):\n${revertedCommitsList}`;

    record.auditLog += `\nCatastrophic rollback to ${targetTag}. ${revertedCount} commits reverted (individual revert commits, tagged at ${rollbackTag}).`;

    this.logger.fatal('Catastrophic rollback executed', {
      targetTag,
      commitsReverted: record.commitsReverted,
    });
  }

  // ============ Git Helpers ============

  private async getMergeBase(branch1: string, branch2: string): Promise<string> {
    return this.git.getMergeBase(branch1, branch2);
  }

  private async getCommitsInRange(from: string, to: string): Promise<string[]> {
    return this.git.getCommitsInRange(from, to);
  }

  private async revertCommit(commitHash: string): Promise<void> {
    await this.git.revert(commitHash);
  }

  private async findLastStableTag(): Promise<string | null> {
    const tags = await this.git.getTags();
    // Look for sprint-complete tags in reverse
    const sprintTags = tags
      .filter(t => t.includes('sprint') && t.includes('complete'))
      .reverse();
    return sprintTags.length > 0 ? sprintTags[0] : null;
  }
}
