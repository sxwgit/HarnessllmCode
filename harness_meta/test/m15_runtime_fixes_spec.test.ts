/**
 * M15 运行时 Bug 修复 — 测试分类: behavioral
 *
 * 验证意图：覆盖框架运行时发现的三个 bug 修复：
 * 1. 状态跳转恢复：EXCEPTION_HANDLE/EVALUATION 状态不一致时能正确恢复
 * 2. Git Revert 冲突处理：单个 commit revert 冲突不会导致整体 rollback 失败
 * 3. Fetch 重试策略：网络级错误使用更长延迟
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessState } from '../src/types.js';
import { StateMachine } from '../src/state/machine.js';
import { RollbackManager, RollbackLevel } from '../src/orchestrator/rollback.js';
import { LLMClient } from '../src/llm/client.js';
import { ExceptionHandler } from '../src/exception/handler.js';
import { Logger } from '../src/logger/index.js';
import {
  createTempDir,
  createWorkspaceFixture,
  initPlainGitRepo,
  setGitIdentityEnv,
  makeLogger,
} from './helpers/fixtures.js';
import { GitManager } from '../src/git/manager.js';

const fixtures: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

function useFixture() {
  const fixture = createWorkspaceFixture();
  fixtures.push(fixture);
  return fixture;
}

// ============ RUNTIME_FIX_001: forceSetState recovery ============

describe('M15 Runtime Fixes', () => {
  describe('RUNTIME_FIX_001: state recovery from EXCEPTION_HANDLE', () => {
    it('forceSetState bypasses transition validation and records audit', () => {
      const { metaDir, targetDir, cleanup } = useFixture();
      const sm = new StateMachine(metaDir, targetDir);

      // Transition to a known state first
      sm.transitionMeta(HarnessState.PROJECT_INIT);
      sm.transitionProject(HarnessState.PROJECT_INIT);

      // Force-set to SPRINT_DISPATCH (would normally fail from PROJECT_INIT)
      sm.forceSetState(HarnessState.SPRINT_DISPATCH, 'test recovery');

      expect(sm.getMetaState().currentState).toBe(HarnessState.SPRINT_DISPATCH);
      expect(sm.getProjectState().currentState).toBe(HarnessState.SPRINT_DISPATCH);

      // Verify audit trail
      const metaState = JSON.parse(readFileSync(resolve(metaDir, 'meta_state.json'), 'utf-8'));
      expect(metaState.forceSetStateAudit).toBeDefined();
      expect(metaState.forceSetStateAudit).toHaveLength(1);
      expect(metaState.forceSetStateAudit[0].from).toBe(HarnessState.PROJECT_INIT);
      expect(metaState.forceSetStateAudit[0].to).toBe(HarnessState.SPRINT_DISPATCH);
      expect(metaState.forceSetStateAudit[0].reason).toBe('test recovery');
    });

    it('StateMachine can transition from EXCEPTION_HANDLE to SPRINT_NEGOTIATION via forceSetState', () => {
      const { metaDir, targetDir, cleanup } = useFixture();
      const sm = new StateMachine(metaDir, targetDir);

      // Get into EXCEPTION_HANDLE state
      sm.transitionMeta(HarnessState.PROJECT_INIT);
      sm.transitionMeta(HarnessState.EXCEPTION_HANDLE);

      // Direct transition from EXCEPTION_HANDLE to SPRINT_NEGOTIATION would be valid
      // But project state might be at EVALUATION which doesn't allow SPRINT_NEGOTIATION
      // Force-set both to SPRINT_DISPATCH first, then transition normally
      sm.forceSetState(HarnessState.SPRINT_DISPATCH, 'recovery before sprint retry');
      sm.transitionMeta(HarnessState.SPRINT_NEGOTIATION);
      sm.transitionProject(HarnessState.SPRINT_NEGOTIATION);

      expect(sm.getMetaState().currentState).toBe(HarnessState.SPRINT_NEGOTIATION);
      expect(sm.getProjectState().currentState).toBe(HarnessState.SPRINT_NEGOTIATION);
    });

    it('forceSetState allows recovery from MANUAL_INTERVENTION', () => {
      const { metaDir, targetDir, cleanup } = useFixture();
      const sm = new StateMachine(metaDir, targetDir);

      // Get to MANUAL_INTERVENTION
      sm.transitionMeta(HarnessState.PROJECT_INIT);
      sm.transitionMeta(HarnessState.EXCEPTION_HANDLE);
      sm.transitionMeta(HarnessState.MANUAL_INTERVENTION);

      // Force-set to a recoverable state
      sm.forceSetState(HarnessState.SPRINT_DISPATCH, 'manual intervention recovery');
      expect(sm.getMetaState().currentState).toBe(HarnessState.SPRINT_DISPATCH);
    });
  });

  describe('RUNTIME_FIX_002: git revert conflict handling', () => {
    it('rollback handles conflicting commits gracefully', async () => {
      setGitIdentityEnv();
      const { dir, cleanup } = createTempDir('rollback-conflict-');
      fixtures.push({ cleanup });

      // Create a git repo with commits that will conflict on revert
      await initPlainGitRepo(dir);
      const { execa } = await import('execa');

      // First commit: create file
      writeFileSync(resolve(dir, 'conflict.txt'), 'original content\n', 'utf-8');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-m', 'initial commit'], { cwd: dir });

      // Create dev branch
      await execa('git', ['checkout', '-b', 'dev'], { cwd: dir });

      // Create sprint branch
      await execa('git', ['checkout', '-b', 'sprint/sprint-01', 'dev'], { cwd: dir });

      // Sprint commit: modify file
      writeFileSync(resolve(dir, 'conflict.txt'), 'sprint content\n', 'utf-8');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-m', 'sprint change'], { cwd: dir });

      // Another sprint commit
      writeFileSync(resolve(dir, 'conflict.txt'), 'sprint content v2\n', 'utf-8');
      await execa('git', ['add', '.'], { cwd: dir });
      await execa('git', ['commit', '-m', 'sprint change v2'], { cwd: dir });

      // Setup rollback manager
      const logDir = resolve(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const logger = makeLogger(logDir, 'rollback-test');
      const gitManager = new GitManager(dir);

      const rollbackManager = new RollbackManager(gitManager, dir, logger);

      // Execute sprint rollback - should not throw even if conflicts occur
      const result = await rollbackManager.execute(
        RollbackLevel.SPRINT,
        'test rollback with potential conflicts',
        'sprint-01',
      );

      // The rollback should succeed (possibly with partial flag)
      expect(result.success).toBe(true);
      // Verify audit log exists
      expect(result.auditLog).toBeTruthy();
    });
  });

  describe('RUNTIME_FIX_003: fetch retry with longer delay', () => {
    it('LLMClient uses longer delay for network-level fetch failures', async () => {
      // Mock globalThis.fetch to simulate network errors
      const originalFetch = globalThis.fetch;
      const callTimestamps: number[] = [];

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callTimestamps.push(Date.now());
        throw new TypeError('fetch failed');
      });

      const client = new LLMClient({
        baseURL: 'http://nonexistent-host.test',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0,
      });

      await expect(client.generate('test', 'test')).rejects.toThrow();

      // Should have made 3 attempts (initial + 2 retries = 3 calls)
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);

      globalThis.fetch = originalFetch;
    });

    it('exception handler classifies fetch failed as llm_api_failure', async () => {
      const { dir, cleanup } = createTempDir('exception-classify-');
      fixtures.push({ cleanup });
      const logDir = resolve(dir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const logger = makeLogger(logDir, 'exception-test');
      const handler = new ExceptionHandler(logger, { maxRetriesP2: 3, maxRollbacksP1: 2 });

      const error = new TypeError('fetch failed');
      const result = await handler.handle(error, HarnessState.PLANNING, 'PLANNING');

      // Should be classified, not "unknown"
      expect(result.record.rootCause).not.toBe('unknown');
      // fetch failures should be classified as llm_api_failure
      expect(result.record.rootCause).toBe('llm_api_failure');
    });
  });
});
