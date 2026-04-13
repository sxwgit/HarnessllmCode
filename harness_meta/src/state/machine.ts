import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { HarnessMetaState, ProjectState, SprintInfo } from '../types.js';
import { HarnessState } from '../types.js';
import type { Checkpoint } from '../orchestrator/checkpoint.js';

export class StateMachine {
  private metaStatePath: string;
  private projectStatePath: string;
  private metaState: HarnessMetaState;
  private projectState: ProjectState;

  constructor(metaDir: string, projectDir: string) {
    this.metaStatePath = resolve(metaDir, 'meta_state.json');
    this.projectStatePath = resolve(projectDir, 'project_state.json');

    this.metaState = this.loadMetaState();
    this.projectState = this.loadProjectState();
  }

  // ============ Meta State ============

  getMetaState(): HarnessMetaState {
    return { ...this.metaState };
  }

  transitionMeta(newState: HarnessState): void {
    this.assertMetaTransitionAllowed(this.metaState.currentState, newState);
    this.metaState.previousState = this.metaState.currentState;
    this.metaState.currentState = newState;
    this.metaState.updatedAt = new Date().toISOString();
    this.saveMetaState();
  }

  incrementError(): void {
    this.metaState.errorCount++;
    this.saveMetaState();
  }

  addTokens(input: number, output: number): void {
    this.metaState.metrics.totalTokensUsed += input + output;
    this.saveMetaState();
  }

  incrementIterations(): void {
    this.metaState.metrics.totalIterations++;
    this.saveMetaState();
  }

  // ============ Project State ============

  getProjectState(): ProjectState {
    return { ...this.projectState };
  }

  transitionProject(newState: HarnessState): void {
    this.assertProjectTransitionAllowed(this.projectState.currentState, newState);
    this.projectState.previousState = this.projectState.currentState;
    this.projectState.currentState = newState;
    this.projectState.version++;
    this.projectState.updatedAt = new Date().toISOString();
    this.saveProjectState();
  }

  setCurrentSprint(sprintId: string | null): void {
    this.projectState.currentSprintId = sprintId;
    this.saveProjectState();
  }

  completeSprint(sprintId: string): void {
    if (!this.projectState.completedSprints.includes(sprintId)) {
      this.projectState.completedSprints.push(sprintId);
    }
    if (this.projectState.currentSprintId === sprintId) {
      this.projectState.currentSprintId = null;
    }
    this.saveProjectState();
  }

  addSprint(sprint: SprintInfo): void {
    this.projectState.sprints.push(sprint);
    this.saveProjectState();
  }

  updateSprint(sprintId: string, update: Partial<SprintInfo>): void {
    const idx = this.projectState.sprints.findIndex(s => s.id === sprintId);
    if (idx >= 0) {
      this.projectState.sprints[idx] = { ...this.projectState.sprints[idx], ...update };
      this.saveProjectState();
    }
  }

  getSprint(sprintId: string): SprintInfo | undefined {
    return this.projectState.sprints.find(s => s.id === sprintId);
  }

  getNextPendingSprint(): SprintInfo | undefined {
    return this.projectState.sprints.find(
      s => s.status === 'pending' && this.areDependenciesMet(s),
    );
  }

  addMilestoneTag(tag: string): void {
    this.projectState.milestoneTags.push(tag);
    this.saveProjectState();
  }

  // ============ Snapshots ============

  createSnapshot(): ProjectState {
    return JSON.parse(JSON.stringify(this.projectState));
  }

  rollbackToSnapshot(snapshot: ProjectState): void {
    this.projectState = JSON.parse(JSON.stringify(snapshot));
    this.saveProjectState();
  }

  restoreFromCheckpoint(checkpoint: Checkpoint): void {
    this.metaState.currentState = checkpoint.state;
    this.metaState.currentSprintId = checkpoint.currentSprintId;
    this.metaState.completedSprints = [...checkpoint.completedSprints];
    this.metaState.metrics = { ...checkpoint.meta };
    this.metaState.updatedAt = new Date().toISOString();

    this.projectState.currentState = checkpoint.state;
    this.projectState.currentSprintId = checkpoint.currentSprintId;
    this.projectState.completedSprints = [...checkpoint.completedSprints];
    this.projectState.milestoneTags = [...checkpoint.gitInfo.tags];
    this.projectState.updatedAt = new Date().toISOString();

    if (checkpoint.currentSprintId) {
      const existing = this.projectState.sprints.find(sprint => sprint.id === checkpoint.currentSprintId);
      if (existing) {
        existing.status = 'in_progress';
      }
    }

    for (const sprint of this.projectState.sprints) {
      if (checkpoint.completedSprints.includes(sprint.id)) {
        sprint.status = 'completed';
      }
    }

    this.saveMetaState();
    this.saveProjectState();
  }

  // ============ Persistence ============

  private loadMetaState(): HarnessMetaState {
    if (existsSync(this.metaStatePath)) {
      return JSON.parse(readFileSync(this.metaStatePath, 'utf-8'));
    }
    return {
      currentState: HarnessState.META_INIT,
      previousState: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      errorCount: 0,
      currentSprintId: null,
      completedSprints: [],
      metrics: {
        totalTokensUsed: 0,
        totalIterations: 0,
        exceptionsHandled: 0,
      },
    };
  }

  private loadProjectState(): ProjectState {
    if (existsSync(this.projectStatePath)) {
      try {
        return JSON.parse(readFileSync(this.projectStatePath, 'utf-8'));
      } catch {
        // Return default state on parse error
      }
    }
    return {
      currentState: HarnessState.PROJECT_INIT,
      previousState: null,
      version: 0,
      initialized: false,
      sprints: [],
      currentSprintId: null,
      completedSprints: [],
      milestoneTags: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private saveMetaState(): void {
    const dir = dirname(this.metaStatePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.metaStatePath, JSON.stringify(this.metaState, null, 2), 'utf-8');
  }

  private saveProjectState(): void {
    const dir = dirname(this.projectStatePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.projectStatePath, JSON.stringify(this.projectState, null, 2), 'utf-8');
  }

  /** Check if all dependencies of a sprint are completed */
  areDependenciesMet(sprint: SprintInfo): boolean {
    return sprint.dependencies.every(depId =>
      this.projectState.completedSprints.includes(depId),
    );
  }

  private assertMetaTransitionAllowed(current: HarnessState, next: HarnessState): void {
    if (current === next) return;

    const allowedTransitions: Partial<Record<HarnessState, HarnessState[]>> = {
      [HarnessState.META_INIT]: [HarnessState.PROJECT_INIT, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.PROJECT_INIT]: [HarnessState.REQUIREMENT_PARSE, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.REQUIREMENT_PARSE]: [HarnessState.PLANNING, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.PLANNING]: [HarnessState.SPRINT_DISPATCH, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.SPRINT_DISPATCH]: [HarnessState.SPRINT_NEGOTIATION, HarnessState.FINAL_ACCEPTANCE, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.SPRINT_NEGOTIATION]: [HarnessState.DEV, HarnessState.EXCEPTION_HANDLE, HarnessState.MANUAL_INTERVENTION],
      [HarnessState.DEV]: [HarnessState.PRE_EVALUATION, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.PRE_EVALUATION]: [HarnessState.EVALUATION, HarnessState.DEV, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.EVALUATION]: [
        HarnessState.SPRINT_MERGE,
        HarnessState.DEV,
        HarnessState.PRE_EVALUATION,
        HarnessState.PLANNING,
        HarnessState.EXCEPTION_HANDLE,
      ],
      [HarnessState.SPRINT_MERGE]: [HarnessState.SPRINT_DISPATCH, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.FINAL_ACCEPTANCE]: [HarnessState.RELEASE, HarnessState.EXCEPTION_HANDLE, HarnessState.MANUAL_INTERVENTION],
      [HarnessState.RELEASE]: [HarnessState.FINISHED, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.EXCEPTION_HANDLE]: [
        HarnessState.MANUAL_INTERVENTION,
        HarnessState.PROJECT_INIT,
        HarnessState.REQUIREMENT_PARSE,
        HarnessState.PLANNING,
        HarnessState.SPRINT_DISPATCH,
        HarnessState.SPRINT_NEGOTIATION,
        HarnessState.DEV,
        HarnessState.PRE_EVALUATION,
        HarnessState.EVALUATION,
        HarnessState.SPRINT_MERGE,
        HarnessState.FINAL_ACCEPTANCE,
        HarnessState.RELEASE,
      ],
      [HarnessState.MANUAL_INTERVENTION]: [HarnessState.EXCEPTION_HANDLE, HarnessState.FINISHED],
    };

    if (!allowedTransitions[current]?.includes(next)) {
      throw new Error(`Invalid meta state transition: ${current} -> ${next}`);
    }
  }

  private assertProjectTransitionAllowed(current: HarnessState, next: HarnessState): void {
    if (current === next) return;

    const allowedTransitions: Partial<Record<HarnessState, HarnessState[]>> = {
      [HarnessState.PROJECT_INIT]: [HarnessState.SPRINT_NEGOTIATION, HarnessState.FINAL_ACCEPTANCE, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.SPRINT_NEGOTIATION]: [HarnessState.DEV, HarnessState.EXCEPTION_HANDLE, HarnessState.MANUAL_INTERVENTION],
      [HarnessState.DEV]: [HarnessState.PRE_EVALUATION, HarnessState.SPRINT_NEGOTIATION, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.PRE_EVALUATION]: [HarnessState.EVALUATION, HarnessState.DEV, HarnessState.SPRINT_NEGOTIATION, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.EVALUATION]: [HarnessState.SPRINT_MERGE, HarnessState.DEV, HarnessState.SPRINT_NEGOTIATION, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.SPRINT_MERGE]: [HarnessState.SPRINT_NEGOTIATION, HarnessState.FINAL_ACCEPTANCE, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.FINAL_ACCEPTANCE]: [HarnessState.RELEASE, HarnessState.EXCEPTION_HANDLE, HarnessState.MANUAL_INTERVENTION],
      [HarnessState.RELEASE]: [HarnessState.FINISHED, HarnessState.EXCEPTION_HANDLE],
      [HarnessState.EXCEPTION_HANDLE]: [
        HarnessState.SPRINT_NEGOTIATION,
        HarnessState.DEV,
        HarnessState.PRE_EVALUATION,
        HarnessState.EVALUATION,
        HarnessState.SPRINT_MERGE,
        HarnessState.FINAL_ACCEPTANCE,
        HarnessState.RELEASE,
        HarnessState.MANUAL_INTERVENTION,
      ],
      [HarnessState.MANUAL_INTERVENTION]: [HarnessState.EXCEPTION_HANDLE, HarnessState.FINISHED],
    };

    if (!allowedTransitions[current]?.includes(next)) {
      throw new Error(`Invalid project state transition: ${current} -> ${next}`);
    }
  }
}
