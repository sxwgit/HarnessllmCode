import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../logger/index.js';
import { HarnessState } from '../types.js';

export interface Checkpoint {
  id: string;
  timestamp: string;
  state: HarnessState;
  currentSprintId: string | null;
  completedSprints: string[];
  meta: {
    totalTokensUsed: number;
    totalIterations: number;
    exceptionsHandled: number;
  };
  gitInfo: {
    currentBranch: string;
    lastCommit: string;
    tags: string[];
  };
  /** Sprint-internal sub-phase (NEGOTIATION | DEV | PRE_EVALUATION | EVALUATION | SPRINT_MERGE) for fine-grained resume */
  sprintSubState?: HarnessState;
  /** Current iteration number within the sprint (1-based) */
  sprintIteration?: number;
}

/**
 * Checkpoint manager for resuming interrupted runs
 *
 * Creates snapshots at every state transition so the framework
 * can resume from the last checkpoint after a crash or interruption.
 */
export class CheckpointManager {
  private checkpointDir: string;
  private logger: Logger;

  constructor(metaDir: string, logger: Logger) {
    this.checkpointDir = resolve(metaDir, 'checkpoints');
    this.logger = logger;
    if (!existsSync(this.checkpointDir)) {
      mkdirSync(this.checkpointDir, { recursive: true });
    }
  }

  /**
   * Save a checkpoint snapshot
   */
  save(checkpoint: Checkpoint): void {
    const filename = `checkpoint_${checkpoint.state}_${Date.now()}.json`;
    const path = resolve(this.checkpointDir, filename);
    writeFileSync(path, JSON.stringify(checkpoint, null, 2), 'utf-8');
    this.logger.info('Checkpoint saved', {
      id: checkpoint.id,
      state: checkpoint.state,
      file: filename,
    });

    // Auto-cleanup old checkpoints (G-15)
    this.cleanup();
  }

  /**
   * Find the latest checkpoint to resume from.
   * Sorts by the embedded timestamp in the filename, NOT alphabetically,
   * because state names (DEV, EVALUATION, PLANNING) have arbitrary alphabetical order.
   */
  getLatest(): Checkpoint | null {
    if (!existsSync(this.checkpointDir)) return null;

    const files = readdirSync(this.checkpointDir)
      .filter(f => f.startsWith('checkpoint_') && f.endsWith('.json'))
      .map(f => ({
        filename: f,
        // Extract timestamp: checkpoint_{STATE}_{TIMESTAMP}.json
        timestamp: parseInt(f.split('_').pop()?.replace('.json', '') || '0', 10),
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    if (files.length === 0) return null;

    const latest = files[0].filename;
    const content = readFileSync(resolve(this.checkpointDir, latest), 'utf-8');

    try {
      return JSON.parse(content) as Checkpoint;
    } catch {
      this.logger.error('Failed to parse checkpoint', { file: latest });
      return null;
    }
  }

  /**
   * Get all checkpoints sorted by time (oldest first)
   */
  getAll(): Checkpoint[] {
    if (!existsSync(this.checkpointDir)) return [];

    const files = readdirSync(this.checkpointDir)
      .filter(f => f.startsWith('checkpoint_') && f.endsWith('.json'))
      .map(f => ({
        filename: f,
        timestamp: parseInt(f.split('_').pop()?.replace('.json', '') || '0', 10),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    return files.map(({ filename }) => {
      try {
        return JSON.parse(
          readFileSync(resolve(this.checkpointDir, filename), 'utf-8'),
        ) as Checkpoint;
      } catch {
        return null;
      }
    }).filter((c): c is Checkpoint => c !== null);
  }

  /**
   * Clean up old checkpoints, keeping only the last N (by timestamp).
   */
  cleanup(keepCount = 10): void {
    if (!existsSync(this.checkpointDir)) return;

    const files = readdirSync(this.checkpointDir)
      .filter(f => f.startsWith('checkpoint_') && f.endsWith('.json'))
      .map(f => ({
        filename: f,
        timestamp: parseInt(f.split('_').pop()?.replace('.json', '') || '0', 10),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const toRemove = files.slice(0, files.length - keepCount);
    for (const { filename } of toRemove) {
      unlinkSync(resolve(this.checkpointDir, filename));
    }
  }

  clear(): void {
    if (!existsSync(this.checkpointDir)) return;

    const files = readdirSync(this.checkpointDir)
      .filter(f => f.startsWith('checkpoint_') && f.endsWith('.json'));

    for (const file of files) {
      unlinkSync(resolve(this.checkpointDir, file));
    }
  }
}
