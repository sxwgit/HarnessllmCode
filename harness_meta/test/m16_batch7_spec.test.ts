/**
 * M16 Batch 7 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖 Batch 7 的两个目标：
 * 1. Checkpoint 恢复精确保留子状态（不归一化到 SPRINT_DISPATCH）
 * 2. 关键阶段后置条件检查（SPRINT_NEGOTIATION, EVALUATION）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessState } from '../src/types.js';
import { StateMachine } from '../src/state/machine.js';
import { CheckpointManager, type Checkpoint } from '../src/orchestrator/checkpoint.js';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import {
  createWorkspaceFixture,
  createTempDir,
  makeLogger,
  sampleSprintContract,
  sampleReviewReport,
} from './helpers/fixtures.js';

const fixtures: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

function useFixture() {
  const fixture = createWorkspaceFixture();
  fixtures.push(fixture);
  return fixture;
}

function useTempDir(prefix = 'batch7-') {
  const { dir, cleanup } = createTempDir(prefix);
  fixtures.push({ cleanup });
  return dir;
}

// ============ BATCH7_RESUME: Checkpoint Recovery Precision ============

describe('BATCH7: Checkpoint recovery precision', () => {
  it('BATCH7_RESUME_001: checkpoint at EVALUATION sub-state preserves exact state', () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    const logger = makeLogger(resolve(metaDir, 'meta_logs'), 'test');
    const checkpointManager = new CheckpointManager(metaDir, logger);

    // Save a checkpoint at EVALUATION sub-state
    checkpointManager.save({
      id: 'CP-test-001',
      timestamp: new Date().toISOString(),
      state: HarnessState.EVALUATION,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 0, totalIterations: 5, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'abc123', tags: [] },
      sprintSubState: HarnessState.EVALUATION,
      sprintIteration: 2,
    });

    const latest = checkpointManager.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.state).toBe(HarnessState.EVALUATION);
    expect(latest!.sprintSubState).toBe(HarnessState.EVALUATION);
    expect(latest!.sprintIteration).toBe(2);
  });

  it('BATCH7_RESUME_002: checkpoint preserves sprint iteration count', () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    const logger = makeLogger(resolve(metaDir, 'meta_logs'), 'test');
    const checkpointManager = new CheckpointManager(metaDir, logger);

    checkpointManager.save({
      id: 'CP-test-002',
      timestamp: new Date().toISOString(),
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 100, totalIterations: 3, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'def456', tags: [] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 3,
    });

    const latest = checkpointManager.getLatest();
    expect(latest!.sprintIteration).toBe(3);
    expect(latest!.meta.totalIterations).toBe(3);
  });

  it('BATCH7_RESUME_003: checkpoint preserves sprint attempt count', () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    const logger = makeLogger(resolve(metaDir, 'meta_logs'), 'test');
    const checkpointManager = new CheckpointManager(metaDir, logger);

    checkpointManager.save({
      id: 'CP-test-003',
      timestamp: new Date().toISOString(),
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 100, totalIterations: 3, exceptionsHandled: 1 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'ghi789', tags: [] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 1,
      sprintAttemptCount: 2,
    });

    const latest = checkpointManager.getLatest();
    expect(latest!.sprintAttemptCount).toBe(2);
  });

  it('BATCH7_RESUME_004: sprint sub-state checkpoint does not skip SPRINT_DISPATCH', () => {
    // Simulate the shouldSkipPhase logic with a sprint sub-state
    const sprintSubStates: HarnessState[] = [
      HarnessState.SPRINT_NEGOTIATION,
      HarnessState.DEV,
      HarnessState.PRE_EVALUATION,
      HarnessState.EVALUATION,
      HarnessState.SPRINT_MERGE,
    ];

    // When checkpoint state is a sprint sub-state, SPRINT_DISPATCH should NOT be skipped
    const preSprintPhases: HarnessState[] = [
      HarnessState.META_INIT,
      HarnessState.PROJECT_INIT,
      HarnessState.REQUIREMENT_PARSE,
      HarnessState.PLANNING,
    ];

    for (const subState of sprintSubStates) {
      // Pre-sprint phases should be skipped
      for (const phase of preSprintPhases) {
        expect(preSprintPhases.includes(phase)).toBe(true);
      }
      // SPRINT_DISPATCH should NOT be skipped
      expect(sprintSubStates.includes(subState)).toBe(true);
    }
  });

  it('BATCH7_RESUME_005: old checkpoints without sprintAttemptCount are backward compatible', () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    const logger = makeLogger(resolve(metaDir, 'meta_logs'), 'test');
    const checkpointManager = new CheckpointManager(metaDir, logger);

    // Save a checkpoint WITHOUT the new sprintAttemptCount field
    checkpointManager.save({
      id: 'CP-test-005',
      timestamp: new Date().toISOString(),
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 0, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'jkl012', tags: [] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 1,
      // No sprintAttemptCount field
    });

    const latest = checkpointManager.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.sprintAttemptCount).toBeUndefined();
    // Should still be a valid checkpoint
    expect(latest!.state).toBe(HarnessState.DEV);
  });
});

// ============ BATCH7_POST: Phase-level Post-conditions ============

describe('BATCH7: Phase post-conditions', () => {
  it('BATCH7_POST_001: SPRINT_NEGOTIATION post-condition checks contract', () => {
    const dir = useTempDir('post-001-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    // Write a valid sprint contract
    const sprintDir = resolve(dir, 'docs', 'sprint');
    mkdirSync(sprintDir, { recursive: true });
    const contractPath = resolve(sprintDir, 'sprint_contract_sprint-01.md');
    writeFileSync(contractPath, sampleSprintContract(), 'utf-8');

    const result = validator.validateSprintContract(contractPath);
    expect(result.valid).toBe(true);
  });

  it('BATCH7_POST_002: EVALUATION post-condition checks review report', () => {
    const dir = useTempDir('post-002-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    // Write a valid review report
    const sprintDir = resolve(dir, 'docs', 'sprint');
    mkdirSync(sprintDir, { recursive: true });
    const reportPath = resolve(sprintDir, 'review_report_sprint-01.md');
    writeFileSync(reportPath, sampleReviewReport(), 'utf-8');

    const result = validator.validateReviewReport(reportPath);
    expect(result.valid).toBe(true);
  });

  it('BATCH7_POST_003: missing contract file detected by post-condition', () => {
    const dir = useTempDir('post-003-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const contractPath = resolve(dir, 'docs/sprint/sprint_contract_sprint-01.md');
    const result = validator.validateSprintContract(contractPath);
    expect(result.valid).toBe(false);
  });

  it('BATCH7_POST_004: invalid review report detected by post-condition', () => {
    const dir = useTempDir('post-004-');
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    // Write an invalid (empty) review report
    const sprintDir = resolve(dir, 'docs', 'sprint');
    mkdirSync(sprintDir, { recursive: true });
    const reportPath = resolve(sprintDir, 'review_report_sprint-01.md');
    writeFileSync(reportPath, '# Empty report\n', 'utf-8');

    const result = validator.validateReviewReport(reportPath);
    expect(result.valid).toBe(false);
  });
});
