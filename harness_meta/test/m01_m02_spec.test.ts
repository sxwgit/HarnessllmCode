import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { FileWriteTool } from '../src/tools/file-write.js';
import { BashTool } from '../src/tools/bash.js';
import { IsolationMonitor } from '../src/isolation/monitor.js';
import { Logger, DualLogger } from '../src/logger/index.js';
import { StateMachine } from '../src/state/machine.js';
import { GitManager } from '../src/git/manager.js';
import { ManualIntervention } from '../src/orchestrator/manual-intervention.js';
import { PlannerAgent } from '../src/agents/planner.js';
import { GeneratorAgent } from '../src/agents/generator.js';
import { EvaluatorAgent } from '../src/agents/evaluator.js';
import { RollbackManager, RollbackLevel } from '../src/orchestrator/rollback.js';
import type { LLMMessage } from '../src/types.js';
import { createWorkspaceFixture, gitLogMessages, HARNESS_ROOT, readHarnessFile } from './helpers/fixtures.js';

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

describe('M01 iron rules and M02 boundary definitions', () => {
  it('IRON_UNIT_001 separates planner, generator, and evaluator responsibilities', () => {
    const { metaDir } = useFixture();
    const client = { chatWithTools: async () => ({ finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, messages: [] }) } as never;
    const tools = { toLLMTools: () => [], execute: async () => ({}) } as never;
    const planner = new PlannerAgent(client, tools);
    const generator = new GeneratorAgent(client, tools, metaDir);
    const evaluator = new EvaluatorAgent(client, tools);

    // Behavioral: distinct instances with different roles
    expect(planner).not.toBe(generator);
    expect(generator).not.toBe(evaluator);
    expect(planner).not.toBe(evaluator);

    // Behavioral: roles are different strings
    expect((planner as any).role).toBe('planner');
    expect((generator as any).role).toBe('generator');
    expect((evaluator as any).role).toBe('evaluator');

    // Behavioral: system prompts are loaded from different files
    expect((planner as any).systemPrompt).not.toBe((generator as any).systemPrompt);
    expect((generator as any).systemPrompt).not.toBe((evaluator as any).systemPrompt);
  });

  it('IRON_UNIT_002 uses file-based artifacts instead of direct conversation handoff', () => {
    const { metaDir, targetDir } = useFixture();
    const client = { chatWithTools: async () => ({ finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, messages: [] }) } as never;
    const tools = { toLLMTools: () => [], execute: async () => ({}) } as never;

    // Behavioral: agents use tool registry (file-based tools) not direct messaging
    const planner = new PlannerAgent(client, tools);
    const generator = new GeneratorAgent(client, tools, metaDir);
    const evaluator = new EvaluatorAgent(client, tools);

    // Each agent has its own tool registry for file-based operations
    expect((planner as any).toolRegistry).toBeDefined();
    expect((generator as any).toolRegistry).toBeDefined();
    expect((evaluator as any).toolRegistry).toBeDefined();

    // Agents do not hold references to each other
    expect(Object.keys(planner)).not.toContain('generator');
    expect(Object.keys(planner)).not.toContain('evaluator');
    expect(Object.keys(generator)).not.toContain('evaluator');
    expect(Object.keys(generator)).not.toContain('planner');
    expect(Object.keys(evaluator)).not.toContain('planner');
    expect(Object.keys(evaluator)).not.toContain('generator');
  });

  it('IRON_UNIT_003 resets context to a lightweight task-scoped payload', async () => {
    const callMessages: LLMMessage[][] = [];
    const client = {
      chatWithTools: async (msgs: LLMMessage[]) => {
        callMessages.push(msgs);
        return { finalResponse: { id: 'r1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }, messages: msgs };
      },
    } as never;
    const tools = { toLLMTools: () => [], execute: async () => ({}) } as never;

    const agent = new PlannerAgent(client, tools);

    // First run
    await agent.run('task one');
    // Second run — must be a clean session
    await agent.run('task two');

    // Each call starts with exactly 2 messages (system + user), no history carried over
    expect(callMessages[0]).toHaveLength(2);
    expect(callMessages[1]).toHaveLength(2);
    expect(callMessages[1][0].role).toBe('system');
    expect(callMessages[1][1].role).toBe('user');

    // User message content does not contain prior task
    expect(callMessages[1][1].content).not.toContain('task one');
  });

  it('IRON_UNIT_004 keeps rollback operations on git revert and preserves traceability', async () => {
    const { targetDir } = useFixture();
    const git = new GitManager(targetDir);
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.createBranch('sprint/01');

    // Make a commit
    writeFileSync(resolve(targetDir, 'src/feature.ts'), 'export const x = 1;\n', 'utf-8');
    await git.addAll();
    await git.commit('feat', 'sprint-01', 'add feature');

    // Rollback via RollbackManager (uses git revert under the hood)
    const logger = new Logger(resolve(targetDir, 'project_logs'), 'rollback');
    const rollback = new RollbackManager(git, targetDir, logger);
    const record = await rollback.execute(RollbackLevel.SPRINT, 'test failure', '01');

    // Behavioral: rollback produces an audit record with level info
    expect(record.level).toBe(RollbackLevel.SPRINT);
    expect(record.auditLog).toBeTruthy();

    // Behavioral: git reset --hard is blocked by BashTool
    const bashTool = new BashTool(targetDir);
    await expect(bashTool.execute({ command: 'git reset --hard HEAD~1' })).rejects.toThrow('SECURITY: Command blocked');
  });

  it('IRON_UNIT_005 keeps sprint negotiation before dev and pre-evaluation before evaluation', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);

    // Cannot skip SPRINT_NEGOTIATION and jump straight to DEV
    expect(() => machine.transitionProject('DEV' as never)).toThrow('Invalid project state transition');

    // Must go through SPRINT_NEGOTIATION first
    machine.transitionProject('SPRINT_NEGOTIATION' as never);
    expect(machine.getProjectState().currentState).toBe('SPRINT_NEGOTIATION');

    // From SPRINT_NEGOTIATION, DEV is allowed
    machine.transitionProject('DEV' as never);
    expect(machine.getProjectState().currentState).toBe('DEV');

    // From DEV, PRE_EVALUATION is allowed
    machine.transitionProject('PRE_EVALUATION' as never);
    expect(machine.getProjectState().currentState).toBe('PRE_EVALUATION');

    // From PRE_EVALUATION, EVALUATION is allowed
    machine.transitionProject('EVALUATION' as never);
    expect(machine.getProjectState().currentState).toBe('EVALUATION');
  });

  it('IRON_UNIT_006 keeps the hard evaluation thresholds at min-dimension 6 and average 7', () => {
    const config = JSON.parse(readFileSync(resolve(HARNESS_ROOT, 'harness_config.json'), 'utf-8')) as {
      thresholds: { evaluationPassScore: number; evaluationMinDimensionScore: number };
    };
    const evaluator = readHarnessFile('src/agents/evaluator.ts');
    expect(config.thresholds.evaluationPassScore).toBe(7);
    expect(config.thresholds.evaluationMinDimensionScore).toBe(6);
    expect(evaluator).toContain('任何维度 < 6分');
    expect(evaluator).toContain('整体加权平均分 < 7分');
  });

  it('IRON_UNIT_007 records manual intervention with git audit and structured logs', async () => {
    const { metaDir, targetDir, cleanup } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/sprint'), { recursive: true });
    const logger = new Logger(resolve(metaDir, 'meta_logs'), 'manual');
    const manual = new ManualIntervention(metaDir, logger, targetDir);

    const record = await manual.requestIntervention('critical failure', 'MANUAL_INTERVENTION' as never, 'boom', '{}');
    const auditFile = resolve(metaDir, 'audit', 'manual_interventions.jsonl');
    const auditMarker = resolve(targetDir, 'docs/sprint', `manual_intervention_${record.id}.md`);

    expect(manual.isPaused()).toBe(true);
    expect(existsSync(auditFile)).toBe(true);
    expect(existsSync(auditMarker)).toBe(true);
    cleanup();
  });

  it('IRON_UNIT_008 routes reverse architecture feedback through the orchestrator modules', () => {
    const feedback = readHarnessFile('src/orchestrator/feedback.ts');
    const harness = readHarnessFile('src/orchestrator/harness.ts');
    expect(feedback).toContain('submitFeedback');
    expect(feedback).toContain('ArchitectureFeedback');
    expect(harness).toContain('FeedbackChannel');
  });

  it('IRON_UNIT_009 restricts tool execution to the target sandbox and blocks dangerous commands', async () => {
    const { metaDir, targetDir } = useFixture();
    const logger = new Logger(resolve(metaDir, 'meta_logs'), 'isolation');
    const monitor = new IsolationMonitor(metaDir, targetDir, logger);
    const writeTool = new FileWriteTool(targetDir);
    writeTool.setIsolationMonitor(monitor);
    const bashTool = new BashTool(targetDir);

    const writeResult = await writeTool.execute({ path: 'src/index.ts', content: 'export {};\n' });
    const blockedWrite = await writeTool.execute({ path: '../harness_meta/secrets.txt', content: 'nope' });
    const blockedSudo = await bashTool.execute({ command: 'sudo ls' }).catch((error: Error) => error.message);
    const blockedRm = await bashTool.execute({ command: 'rm -rf /' }).catch((error: Error) => error.message);

    expect(writeResult).toContain('Successfully wrote');
    expect(blockedWrite).toContain('Path traversal detected');
    expect(blockedSudo).toContain('SECURITY: Command blocked');
    expect(blockedRm).toContain('SECURITY: Command blocked');
  });

  it('IRON_UNIT_010 detects cross-repo violations and records them', () => {
    const { metaDir, targetDir } = useFixture();
    const logger = new Logger(resolve(metaDir, 'meta_logs'), 'isolation');
    const monitor = new IsolationMonitor(metaDir, targetDir, logger);

    expect(() => monitor.validateNotMetaPath(resolve(metaDir, 'harness_config.json'))).toThrow();
    const metrics = monitor.getMetrics();
    expect(metrics.violations).toBe(1);
    expect(metrics.violationsByType.meta_write_attempt).toBe(1);
  });

  it('IRON_UNIT_011 enforces physical and permission isolation between meta and target directories', () => {
    const { metaDir, targetDir } = useFixture();
    const metaFile = resolve(metaDir, 'src', 'readonly.txt');
    mkdirSync(resolve(metaDir, 'src'), { recursive: true });
    writeFileSync(metaFile, 'readonly', 'utf-8');
    const noopLogger = {
      info() {},
      debug() {},
      warn() {},
      error() {},
      fatal() {},
    } as Logger;
    const monitor = new IsolationMonitor(metaDir, targetDir, noopLogger);

    monitor.lockMetaDirectory();
    const mode = statSync(metaFile).mode & 0o777;
    monitor.unlockMetaDirectory();

    expect(targetDir.startsWith(metaDir)).toBe(false);
    expect(metaDir.startsWith(targetDir)).toBe(false);
    expect(mode & 0o222).toBe(0);
  });

  it('IRON_UNIT_012 keeps meta and target git repositories independent', async () => {
    const { metaDir, targetDir } = useFixture();
    mkdirSync(resolve(metaDir, '.git'), { recursive: true });
    const gitManager = new GitManager(targetDir);
    await gitManager.initTargetRepo();

    expect(existsSync(resolve(metaDir, '.git'))).toBe(true);
    expect(existsSync(resolve(targetDir, '.git'))).toBe(true);
    expect(resolve(metaDir, '.git')).not.toBe(resolve(targetDir, '.git'));
  });

  it('IRON_UNIT_013 keeps agent and tool operations inside the target workspace', async () => {
    const { metaDir, targetDir } = useFixture();
    const logger = new Logger(resolve(metaDir, 'meta_logs'), 'isolation');
    const monitor = new IsolationMonitor(metaDir, targetDir, logger);
    const writeTool = new FileWriteTool(targetDir);
    writeTool.setIsolationMonitor(monitor);
    const bashTool = new BashTool(targetDir);

    const pwd = await bashTool.execute({ command: 'pwd' });
    const escaped = await writeTool.execute({ path: '../../outside.txt', content: 'bad' });

    expect(pwd.trim()).toBe(targetDir);
    expect(escaped).toContain('Path traversal detected');
  });

  it('IRON_UNIT_014 blocks destructive git and system operations', async () => {
    const bashTool = new BashTool(process.cwd());
    await expect(bashTool.execute({ command: 'git reset --hard HEAD~1' })).rejects.toThrow('SECURITY: Command blocked');
    await expect(bashTool.execute({ command: 'git push origin --force' })).rejects.toThrow('SECURITY: Command blocked');
    await expect(bashTool.execute({ command: 'git rm -rf .git' })).rejects.toThrow('SECURITY: Command blocked');
  });

  it('IRON_UNIT_015 keeps states and logs separated and JSON structured', () => {
    const { metaDir, targetDir } = useFixture();
    const dualLogger = new DualLogger(resolve(metaDir, 'meta_logs'), resolve(targetDir, 'project_logs'));
    dualLogger.meta('meta').info('meta-entry', { state: 'META_INIT' });
    dualLogger.project('project').info('project-entry', { state: 'PROJECT_INIT' });

    const machine = new StateMachine(metaDir, targetDir);
    machine.transitionMeta('PROJECT_INIT' as never);
    machine.transitionMeta('REQUIREMENT_PARSE' as never);
    machine.transitionMeta('PLANNING' as never);
    machine.transitionProject('SPRINT_NEGOTIATION' as never);
    machine.transitionProject('DEV' as never);

    const metaState = JSON.parse(readFileSync(resolve(metaDir, 'meta_state.json'), 'utf-8')) as { currentState: string };
    const projectState = JSON.parse(readFileSync(resolve(targetDir, 'project_state.json'), 'utf-8')) as { currentState: string };
    const metaLog = readFileSync(resolve(metaDir, 'meta_logs', `${new Date().toISOString().split('T')[0]}.jsonl`), 'utf-8');
    const projectLog = readFileSync(resolve(targetDir, 'project_logs', `${new Date().toISOString().split('T')[0]}.jsonl`), 'utf-8');

    expect(metaState.currentState).toBe('PLANNING');
    expect(projectState.currentState).toBe('DEV');
    expect(() => JSON.parse(metaLog.trim().split('\n')[0])).not.toThrow();
    expect(() => JSON.parse(projectLog.trim().split('\n')[0])).not.toThrow();
  });

  it('IRON_INT_001 interrupts rule-violating cross-repo writes immediately', () => {
    const { metaDir, targetDir } = useFixture();
    const monitor = new IsolationMonitor(metaDir, targetDir, new Logger(resolve(metaDir, 'meta_logs'), 'iso'));
    expect(() => monitor.validateGitOperation('commit illegal write', metaDir)).toThrow();
  });

  it('IRON_INT_002 blocks entry into development before contract and pre-evaluation gates', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);

    // Cannot jump from PROJECT_INIT directly to DEV (must go through SPRINT_NEGOTIATION)
    expect(() => machine.transitionProject('DEV' as never)).toThrow('Invalid project state transition');

    // Must follow the canonical path: SPRINT_NEGOTIATION -> DEV -> PRE_EVALUATION -> EVALUATION
    machine.transitionProject('SPRINT_NEGOTIATION' as never);
    machine.transitionProject('DEV' as never);
    expect(machine.getProjectState().currentState).toBe('DEV');

    // Cannot skip from DEV directly to EVALUATION (must go through PRE_EVALUATION)
    expect(() => machine.transitionProject('EVALUATION' as never)).toThrow('Invalid project state transition');

    // Must go through PRE_EVALUATION first
    machine.transitionProject('PRE_EVALUATION' as never);
    machine.transitionProject('EVALUATION' as never);
    expect(machine.getProjectState().currentState).toBe('EVALUATION');
  });

  it('IRON_INT_003 intercepts high-risk git operations before execution', async () => {
    const bashTool = new BashTool(process.cwd());
    await expect(bashTool.execute({ command: 'git reset --hard HEAD~1' })).rejects.toThrow('SECURITY: Command blocked');
  });

  it('DEF_UNIT_001 defines the meta-program as the framework codebase itself', () => {
    expect(existsSync(resolve(HARNESS_ROOT, 'src'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'prompts'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'harness_config.json'))).toBe(true);
  });

  it('DEF_UNIT_002 defines the target project as the isolated output workspace', async () => {
    const { targetDir } = useFixture();
    const gitManager = new GitManager(targetDir);
    await gitManager.initTargetRepo();

    expect(existsSync(resolve(targetDir, 'src'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'test'))).toBe(true);
    expect(existsSync(resolve(targetDir, '.gitignore'))).toBe(true);
  });

  it('DEF_UNIT_003 keeps directory path responsibilities isolated', () => {
    const { metaDir, targetDir } = useFixture();
    const monitor = new IsolationMonitor(metaDir, targetDir, new Logger(resolve(metaDir, 'meta_logs'), 'iso'));
    expect(() => monitor.validateTargetPath('../harness_meta/harness_config.json')).toThrow();
  });

  it('DEF_UNIT_004 keeps framework config inside meta and never stores plaintext api keys', () => {
    const config = JSON.parse(readFileSync(resolve(HARNESS_ROOT, 'harness_config.json'), 'utf-8')) as {
      llm: Record<string, unknown>;
    };
    expect(existsSync(resolve(HARNESS_ROOT, 'harness_config.json'))).toBe(true);
    expect('apiKey' in config.llm).toBe(false);
    expect('apiKeyEnvVar' in config.llm).toBe(false);
  });

  it('DEF_UNIT_005 persists meta and project states independently', () => {
    const { metaDir, targetDir } = useFixture();
    const machine = new StateMachine(metaDir, targetDir);
    machine.transitionMeta('META_INIT' as never);
    machine.transitionProject('PROJECT_INIT' as never);
    const metaState = readFileSync(resolve(metaDir, 'meta_state.json'), 'utf-8');
    const projectState = readFileSync(resolve(targetDir, 'project_state.json'), 'utf-8');
    expect(metaState).toContain('"metrics"');
    expect(projectState).toContain('"sprints"');
  });

  it('DEF_UNIT_006 expects the full same-level directory layout mandated by the framework', () => {
    expect(existsSync(resolve(HARNESS_ROOT, 'src/orchestrator'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/agents'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/tools'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/exception'))).toBe(true);
    expect(existsSync(resolve(HARNESS_ROOT, 'src/dual_git_manager'))).toBe(true);
  });

  it('DEF_UNIT_007 expects nested deployments to ignore target_project from meta git', () => {
    const gitignorePath = resolve(HARNESS_ROOT, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    expect(gitignore).toContain('target_project/');
  });

  it('DEF_UNIT_008 keeps mandatory ignore rules in both repositories', async () => {
    const { metaDir, targetDir } = useFixture();
    const gitManager = new GitManager(targetDir);
    await gitManager.initTargetRepo();

    const metaGitignore = readFileSync(resolve(metaDir, '.gitignore'), 'utf-8');
    const targetGitignore = readFileSync(resolve(targetDir, '.gitignore'), 'utf-8');

    expect(metaGitignore).toContain('meta_logs/');
    expect(metaGitignore).toContain('meta_state.json');
    expect(targetGitignore).toContain('project_logs/');
    expect(targetGitignore).toContain('project_state.json');
    expect(targetGitignore).toContain('node_modules/');
  });

  it('DEF_UNIT_009 keeps local config overrides and runtime artifacts out of the published repository', () => {
    const metaGitignore = readFileSync(resolve(HARNESS_ROOT, '.gitignore'), 'utf-8');
    const configSource = readHarnessFile('src/config.ts');

    expect(metaGitignore).toContain('harness_config.local.json');
    expect(metaGitignore).toContain('harness_secrets.local.json');
    expect(metaGitignore).toContain('audit/');
    expect(metaGitignore).toContain('checkpoints/');
    expect(configSource).toContain('harness_config.local.json');
    expect(configSource).toContain('harness_secrets.local.json');
    expect(configSource).toContain('Plaintext API keys are prohibited in config files');
  });

  it('DEF_INT_001 preserves core definitions after normal operations', async () => {
    const { metaDir, targetDir } = useFixture();
    const gitManager = new GitManager(targetDir);
    await gitManager.initTargetRepo();
    const machine = new StateMachine(metaDir, targetDir);
    machine.transitionMeta('PROJECT_INIT' as never);
    machine.transitionMeta('REQUIREMENT_PARSE' as never);
    machine.transitionMeta('PLANNING' as never);
    machine.transitionProject('SPRINT_NEGOTIATION' as never);
    machine.transitionProject('DEV' as never);

    expect(existsSync(resolve(metaDir, 'meta_state.json'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'project_state.json'))).toBe(true);
    expect(existsSync(resolve(targetDir, '.git'))).toBe(true);
  });

  it('DEF_INT_002 preserves isolation and git history during exception-era recovery work', async () => {
    const { targetDir } = useFixture();
    const gitManager = new GitManager(targetDir);
    await gitManager.initTargetRepo();
    await gitManager.ensureBranch('dev');
    await gitManager.createBranch('sprint/01');
    writeFileSync(resolve(targetDir, 'src/index.ts'), 'console.log("ok");\n', 'utf-8');
    await gitManager.addAll();
    await gitManager.commit('feat', 'project', 'add app entry');
    const messages = await gitLogMessages(targetDir);
    expect(messages.some(message => message.startsWith('init(project):'))).toBe(true);
    expect(messages.some(message => message.startsWith('feat(project):'))).toBe(true);
  });
});
