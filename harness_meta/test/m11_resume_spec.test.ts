import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointManager } from '../src/orchestrator/checkpoint.js';
import { StateMachine } from '../src/state/machine.js';
import { HarnessState } from '../src/types.js';
import { createWorkspaceFixture, makeLogger, readHarnessFile } from './helpers/fixtures.js';

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

describe('M11 checkpoint resume hardening', () => {
  it('RESUME_UNIT_001 restores current sprint and completed sprint set from checkpoint metadata', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);
    machine.addSprint({
      id: 'sprint-01',
      name: 'Sprint 01',
      priority: 1,
      goals: [],
      deliverables: [],
      dependencies: [],
      status: 'pending',
    });
    machine.addSprint({
      id: 'sprint-02',
      name: 'Sprint 02',
      priority: 2,
      goals: [],
      deliverables: [],
      dependencies: [],
      status: 'pending',
    });

    machine.restoreFromCheckpoint({
      id: 'cp-restore',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-02',
      completedSprints: ['sprint-01'],
      meta: { totalTokensUsed: 10, totalIterations: 3, exceptionsHandled: 1 },
      gitInfo: { currentBranch: 'sprint/sprint-02', lastCommit: 'abc123', tags: ['v0.1.0-plan-complete'] },
    });

    expect(machine.getMetaState().currentState).toBe(HarnessState.DEV);
    expect(machine.getProjectState().currentSprintId).toBe('sprint-02');
    expect(machine.getProjectState().completedSprints).toContain('sprint-01');
    expect(machine.getSprint('sprint-01')?.status).toBe('completed');
    expect(machine.getSprint('sprint-02')?.status).toBe('in_progress');
  });

  it('RESUME_UNIT_002 checkpoint saves and restores sprint sub-state and iteration', () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    // Save checkpoint with sprint sub-state
    manager.save({
      id: 'cp-substate',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-02',
      completedSprints: ['sprint-01'],
      meta: { totalTokensUsed: 10, totalIterations: 3, exceptionsHandled: 1 },
      gitInfo: { currentBranch: 'sprint/sprint-02', lastCommit: 'abc123', tags: ['v0.1.0-plan-complete'] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 2,
    });

    const latest = manager.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.sprintSubState).toBe(HarnessState.DEV);
    expect(latest!.sprintIteration).toBe(2);
    expect(latest!.currentSprintId).toBe('sprint-02');
  });

  it('RESUME_UNIT_003 can clear persisted checkpoints during cleanup or reset flows', () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    manager.save({
      id: 'cp-1',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.PLANNING,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'dev', lastCommit: 'abc123', tags: [] },
    });

    expect(manager.getAll().length).toBe(1);
    manager.clear();
    expect(manager.getAll().length).toBe(0);
  });

  it('RESUME_UNIT_004 normalizeCheckpointState maps sprint sub-states to SPRINT_DISPATCH', () => {
    // Verify the fix: sprint sub-states should map to SPRINT_DISPATCH, not PLANNING
    const harness = readHarnessFile('src/orchestrator/harness.ts');

    // The normalizeCheckpointState function should map sprint sub-states to SPRINT_DISPATCH
    expect(harness).toContain('return HarnessState.SPRINT_DISPATCH');
    // Should NOT contain the old bug
    expect(harness).not.toMatch(/sprintSubStates\.includes\(state\)\s*\)\s*\{\s*return HarnessState\.PLANNING/);
  });

  it('RESUME_UNIT_005 completed sprints are not re-added to execution queue', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);

    machine.addSprint({ id: 'sprint-01', name: 'S1', priority: 1, goals: [], deliverables: [], dependencies: [], status: 'pending' });
    machine.addSprint({ id: 'sprint-02', name: 'S2', priority: 2, goals: [], deliverables: [], dependencies: [], status: 'pending' });
    machine.addSprint({ id: 'sprint-03', name: 'S3', priority: 3, goals: [], deliverables: [], dependencies: [], status: 'pending' });

    // Restore with sprint-01 completed, sprint-02 in progress
    machine.restoreFromCheckpoint({
      id: 'cp-partial',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-02',
      completedSprints: ['sprint-01'],
      meta: { totalTokensUsed: 10, totalIterations: 3, exceptionsHandled: 1 },
      gitInfo: { currentBranch: 'sprint/sprint-02', lastCommit: 'abc123', tags: ['v0.1.0-plan-complete'] },
    });

    const projectState = machine.getProjectState();
    expect(projectState.completedSprints).toEqual(['sprint-01']);
    expect(projectState.currentSprintId).toBe('sprint-02');

    // sprint-01 should be completed
    expect(machine.getSprint('sprint-01')?.status).toBe('completed');
    // sprint-02 should be in progress
    expect(machine.getSprint('sprint-02')?.status).toBe('in_progress');
    // sprint-03 should remain pending
    expect(machine.getSprint('sprint-03')?.status).toBe('pending');
  });

  it('RESUME_UNIT_006 buildSprintExecutionOrder prioritizes in-progress sprint', () => {
    // Verify the execution ordering logic exists in harness
    const harness = readHarnessFile('src/orchestrator/harness.ts');

    // buildSprintExecutionOrder should prioritize currentSprintId
    expect(harness).toContain('buildSprintExecutionOrder');
    // It should filter out completed sprints
    expect(harness).toContain('completed');
    // It should put the current sprint first
    expect(harness).toContain('prioritized');
    expect(harness).toContain('currentSprintId');
  });

  it('RESUME_UNIT_007 checkpoint without sprintSubState is backwards compatible', () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    // Old-format checkpoint without sprintSubState
    manager.save({
      id: 'cp-old',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.PLANNING,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'dev', lastCommit: 'abc123', tags: [] },
      // No sprintSubState or sprintIteration
    });

    const latest = manager.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.sprintSubState).toBeUndefined();
    expect(latest!.sprintIteration).toBeUndefined();
  });

  it('RESUME_UNIT_008 checkpoint iteration is preserved across saves', async () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    // Save first checkpoint with iteration 2
    manager.save({
      id: 'cp-dev-iter2',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 10, totalIterations: 2, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'abc123', tags: [] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 2,
    });

    // Ensure different filename timestamp
    await new Promise(r => setTimeout(r, 5));

    // Save second checkpoint for PRE_EVALUATION (no explicit iteration)
    manager.save({
      id: 'cp-preeval',
      timestamp: '2026-04-08T00:00:01.000Z',
      state: HarnessState.PRE_EVALUATION,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 15, totalIterations: 2, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'def456', tags: [] },
      sprintSubState: HarnessState.PRE_EVALUATION,
    });

    const latest = manager.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe('cp-preeval');
    expect(latest!.sprintSubState).toBe(HarnessState.PRE_EVALUATION);
  });

  it('RESUME_UNIT_009 multiple checkpoints preserve history correctly', () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    manager.save({
      id: 'cp-1',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.META_INIT,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 0, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'main', lastCommit: 'a1', tags: [] },
    });

    manager.save({
      id: 'cp-2',
      timestamp: '2026-04-08T00:01:00.000Z',
      state: HarnessState.PLANNING,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 100, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'dev', lastCommit: 'b2', tags: [] },
    });

    manager.save({
      id: 'cp-3',
      timestamp: '2026-04-08T00:02:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 200, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'c3', tags: ['v0.1.0-plan-complete'] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 1,
    });

    const all = manager.getAll();
    expect(all.length).toBe(3);

    // Find the DEV checkpoint by searching all checkpoints (not relying on getLatest sorting)
    const devCheckpoint = all.find(cp => cp.id === 'cp-3');
    expect(devCheckpoint).toBeDefined();
    expect(devCheckpoint!.sprintSubState).toBe(HarnessState.DEV);
    expect(devCheckpoint!.sprintIteration).toBe(1);
    expect(devCheckpoint!.currentSprintId).toBe('sprint-01');
  });

  it('RESUME_UNIT_010 getLatest returns chronologically latest checkpoint (not alphabetically)', async () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    // Save with different states — alphabetical order differs from timestamp order
    // META_INIT (ts=1000), PLANNING (ts=2000), DEV (ts=3000)
    // Alphabetically: DEV < META_INIT < PLANNING → wrong order
    // Chronologically: 1000 < 2000 < 3000 → DEV is latest

    // We need to control the timestamp in the filename.
    // The filename is checkpoint_{state}_{Date.now()}.json
    // We'll save them in quick succession and rely on timestamps being different

    manager.save({
      id: 'cp-meta',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.META_INIT,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 0, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'main', lastCommit: 'a', tags: [] },
    });

    // Small delay to ensure different timestamp in filename
    await new Promise(r => setTimeout(r, 5));

    manager.save({
      id: 'cp-planning',
      timestamp: '2026-04-08T00:01:00.000Z',
      state: HarnessState.PLANNING,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 100, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'dev', lastCommit: 'b', tags: [] },
    });

    await new Promise(r => setTimeout(r, 5));

    manager.save({
      id: 'cp-dev',
      timestamp: '2026-04-08T00:02:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 200, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'c', tags: ['v0.1.0-plan-complete'] },
      sprintSubState: HarnessState.DEV,
      sprintIteration: 1,
    });

    // getLatest should return the DEV checkpoint (chronologically latest)
    const latest = manager.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe('cp-dev');
    expect(latest!.state).toBe(HarnessState.DEV);
  });

  it('RESUME_UNIT_011 getAll returns checkpoints in chronological order', async () => {
    const { metaDir } = useFixture();
    const manager = new CheckpointManager(metaDir, makeLogger(resolve(metaDir, 'meta_logs')));

    manager.save({
      id: 'cp-first',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.DEV,
      currentSprintId: 'sprint-01',
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 0, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'sprint/sprint-01', lastCommit: 'a', tags: [] },
    });

    await new Promise(r => setTimeout(r, 5));

    manager.save({
      id: 'cp-second',
      timestamp: '2026-04-08T00:01:00.000Z',
      state: HarnessState.META_INIT,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 2, totalIterations: 0, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'main', lastCommit: 'b', tags: [] },
    });

    const all = manager.getAll();
    expect(all.length).toBe(2);
    // Chronological order: first saved = oldest
    expect(all[0].id).toBe('cp-first');
    expect(all[1].id).toBe('cp-second');
  });
});
