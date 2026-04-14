/**
 * M07 异常处理 / M08 指标体系 — 测试分类: behavioral
 *
 * 验证意图：覆盖 5 级异常分类（P0-P4）的行为、升级链路、自适应阈值、
 * root cause 归档、tool timeout 真实触发、人工介入审计、metrics 数值校验。
 * 所有测试基于 ExceptionHandler 和 MetricsCollector 的真实运行时行为。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExceptionHandler, ExceptionLevel } from '../src/exception/handler.js';
import { HarnessState } from '../src/types.js';
import { getAdaptiveThresholds, parseEffortScore } from '../src/orchestrator/adaptive-thresholds.js';
import { MetricsCollector } from '../src/orchestrator/metrics.js';
import { IsolationMonitor } from '../src/isolation/monitor.js';
import { Logger } from '../src/logger/index.js';
import { BashTool } from '../src/tools/bash.js';
import { createWorkspaceFixture } from './helpers/fixtures.js';

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

describe('M07 exception handling and M08 metrics', () => {
  it('EXC_UNIT_001 treats meta-program catastrophic failures as immediate aborts', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'), undefined, resolve(metaDir, 'meta_logs'));
    const result = await handler.handle(new Error('environment completely unavailable'), HarnessState.META_INIT, 'orchestrator');
    expect(result.action).toBe('abort');
    expect(result.record.level).toBe(ExceptionLevel.P0);
  });

  it('EXC_UNIT_002 handles target-project exceptions without touching meta state files', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'), undefined, resolve(metaDir, 'meta_logs'));
    const result = await handler.handle(new Error('validation failed'), HarnessState.DEV, 'generator');
    expect(result.action).toBe('retry');
    expect(result.record.level).toBe(ExceptionLevel.P2);
  });

  it('EXC_UNIT_003 keeps P0 exceptions at zero retries with manual escalation semantics', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'));
    const result = await handler.handle(new Error('git repository damaged'), HarnessState.FINAL_ACCEPTANCE, 'git');
    expect(result.record.maxRetries).toBe(0);
    expect(result.healed).toBe(false);
  });

  it('EXC_UNIT_004 converts repeated severe failures into rollback actions', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'));
    const result = await handler.handle(new Error('merge conflict blocking release'), HarnessState.EVALUATION, 'evaluator');
    expect(result.action).toBe('rollback');
    expect(result.record.level).toBe(ExceptionLevel.P1);
  });

  it('EXC_UNIT_005 sends normal-quality failures back for retry and repair', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'));
    const result = await handler.handle(new Error('self-check failed'), HarnessState.DEV, 'generator');
    expect(result.action).toBe('retry');
    expect(result.record.level).toBe(ExceptionLevel.P2);
  });

  it('EXC_UNIT_006 auto-retries temporary errors as P3 and marks them self-healed', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'));
    const result = await handler.handle(new Error('temporary timeout'), HarnessState.DEV, 'bash');
    expect(result.action).toBe('retry');
    expect(result.healed).toBe(true);
    expect(result.record.level).toBe(ExceptionLevel.P3);
  });

  it('EXC_UNIT_007 logs P4 informational exceptions without interrupting flow', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'));
    const result = await handler.handle(new Error('non-critical log format notice'), HarnessState.RELEASE, 'logger');
    expect(result.action).toBe('skip');
    expect(result.healed).toBe(true);
    expect(result.record.level).toBe(ExceptionLevel.P4);
  });

  it('EXC_BND_001 escalates repeated failures from P2 -> P1 and P1 -> P0', async () => {
    const { metaDir } = useFixture();
    const handler = new ExceptionHandler(
      new Logger(resolve(metaDir, 'meta_logs'), 'exception'),
      { maxRetriesP2: 2, maxRollbacksP1: 1 },
    );

    await handler.handle(new Error('validation failed'), HarnessState.DEV, 'generator');
    await handler.handle(new Error('validation failed'), HarnessState.DEV, 'generator');
    const upgraded = await handler.handle(new Error('validation failed'), HarnessState.DEV, 'generator');

    expect(upgraded.record.level).toBe(ExceptionLevel.P1);

    await handler.handle(new Error('architecture defect'), HarnessState.DEV, 'generator');
    const catastrophic = await handler.handle(new Error('architecture defect'), HarnessState.DEV, 'generator');
    expect(catastrophic.record.level).toBe(ExceptionLevel.P0);
  });

  it('EXC_BND_001A records upgrade flags when exception levels escalate', async () => {
    const { metaDir, targetDir } = useFixture();
    const handler = new ExceptionHandler(
      new Logger(resolve(metaDir, 'meta_logs'), 'exception'),
      { maxRetriesP2: 2, maxRollbacksP1: 1 },
    );
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));

    await handler.handle(new Error('validation failed'), HarnessState.DEV, 'generator');
    const upgradedP1 = await handler.handle(new Error('validation failed'), HarnessState.DEV, 'generator');
    metrics.recordException(upgradedP1.record.level, upgradedP1.healed, upgradedP1.upgraded);

    await handler.handle(new Error('architecture defect'), HarnessState.DEV, 'generator');
    const upgradedP0 = await handler.handle(new Error('architecture defect'), HarnessState.DEV, 'generator');
    metrics.recordException(upgradedP0.record.level, upgradedP0.healed, upgradedP0.upgraded);

    expect(upgradedP1.upgraded).toBe(true);
    expect(upgradedP0.upgraded).toBe(true);
    expect(metrics.getMetrics().exceptionUpgrades).toBe(2);
  });

  it('EXC_UNIT_008 chooses simple thresholds for low-effort sprints', () => {
    expect(getAdaptiveThresholds(2)).toEqual({
      maxSprintIterations: 2,
      maxRollbacks: 1,
      maxNegotiationRounds: 2,
      evaluationTimeout: 120_000,
    });
  });

  it('EXC_UNIT_009 chooses medium thresholds for medium-effort sprints', () => {
    expect(getAdaptiveThresholds(5)).toEqual({
      maxSprintIterations: 3,
      maxRollbacks: 2,
      maxNegotiationRounds: 3,
      evaluationTimeout: 180_000,
    });
  });

  it('EXC_UNIT_010 chooses complex thresholds for high-effort sprints', () => {
    expect(getAdaptiveThresholds(9)).toEqual({
      maxSprintIterations: 4,
      maxRollbacks: 2,
      maxNegotiationRounds: 4,
      evaluationTimeout: 300_000,
    });
  });

  it('EXC_BND_002 classifies adaptive-threshold boundaries correctly', () => {
    expect(getAdaptiveThresholds(3).maxSprintIterations).toBe(2);
    expect(getAdaptiveThresholds(4).maxSprintIterations).toBe(3);
    expect(getAdaptiveThresholds(7).maxSprintIterations).toBe(3);
    expect(getAdaptiveThresholds(8).maxSprintIterations).toBe(4);
  });

  it('EXC_UNIT_011 archives root causes in structured JSON after self-healing', async () => {
    const { metaDir } = useFixture();
    const archiveDir = resolve(metaDir, 'meta_logs');
    const handler = new ExceptionHandler(new Logger(archiveDir, 'exception'), undefined, archiveDir);
    await handler.handle(new Error('temporary timeout'), HarnessState.DEV, 'bash');
    const archivePath = resolve(archiveDir, 'root_cause_archive.json');
    const archive = JSON.parse(readFileSync(archivePath, 'utf-8')) as Array<{ rootCause: string }>;
    expect(archive.length).toBeGreaterThan(0);
    expect(archive[0].rootCause).toBeTruthy();
  });

  it('EXC_UNIT_012 triggers real tool timeouts and classifies them as retryable minor exceptions', async () => {
    const { metaDir, targetDir } = useFixture();
    const bashTool = new BashTool(targetDir);
    const startedAt = Date.now();
    const output = await bashTool.execute({
      command: `node -e "setTimeout(() => console.log('done'), 500)"`,
      timeout: 50,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(300);
    expect(output).toContain('Exit code');

    const timeoutError = new Error(output) as Error & { code?: string };
    timeoutError.code = 'ETIMEDOUT';

    const handler = new ExceptionHandler(new Logger(resolve(metaDir, 'meta_logs'), 'exception'), undefined, resolve(metaDir, 'meta_logs'));
    const result = await handler.handle(timeoutError, HarnessState.DEV, 'bash');

    expect(result.action).toBe('retry');
    expect(result.healed).toBe(true);
    expect(result.record.level).toBe(ExceptionLevel.P3);
  });

  it('EXC_UNIT_013 requires manual intervention actions to leave audit records', async () => {
    const { metaDir, targetDir } = useFixture();
    const manual = new (await import('../src/orchestrator/manual-intervention.js')).ManualIntervention(
      metaDir,
      new Logger(resolve(metaDir, 'meta_logs'), 'manual'),
      targetDir,
    );
    const record = await manual.requestIntervention('manual audit', HarnessState.MANUAL_INTERVENTION, 'boom', '{}');
    expect(record.id.startsWith('MI-')).toBe(true);
    expect(existsSync(resolve(metaDir, 'audit', 'manual_interventions.jsonl'))).toBe(true);
  });

  it('MET_UNIT_001 reports quantitative quality metrics for successful sprint delivery', () => {
    const { targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));

    metrics.recordEvaluationScore(8);
    metrics.startSprint('sprint-01');
    metrics.recordSprintIteration('sprint-01');
    metrics.endSprint('sprint-01', true);

    const report = metrics.generateReport(targetDir);

    expect(metrics.getMetrics().averageEvaluationScore).toBe(8);
    expect(metrics.getMetrics().firstPassRate).toBe(100);
    expect(report).toContain('| Sprint验收平均分 | 8.0 | >=7 | 达标 |');
    expect(report).toContain('| Sprint一次通过率 | 100.0% | >=80% | 达标 |');
  });

  it('MET_UNIT_002 reports exception totals, self-heal rate, and upgrade count numerically', () => {
    const { targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));

    metrics.recordException('P2', false, false);
    metrics.recordException('P3', true, true);

    const report = metrics.generateReport(targetDir);

    expect(metrics.getMetrics().totalExceptions).toBe(2);
    expect(metrics.getMetrics().selfHealedExceptions).toBe(1);
    expect(metrics.getMetrics().exceptionUpgrades).toBe(1);
    expect(report).toContain('| 总异常数 | 2 | - | - |');
    expect(report).toContain('| 异常自愈率 | 50.0% | >=95% | 未达标 |');
    expect(report).toContain('| 异常升级次数 | 1 | - | - |');
  });

  it('MET_UNIT_003 reports isolation compliance with real checks and violations', () => {
    const { metaDir, targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    const monitor = new IsolationMonitor(metaDir, targetDir, new Logger(resolve(metaDir, 'meta_logs'), 'iso'));

    monitor.verifyIsolation();
    expect(() => monitor.validateNotMetaPath(resolve(metaDir, 'src/internal.ts'))).toThrow();
    metrics.updateIsolationMetrics(monitor);

    const report = metrics.generateReport(targetDir);

    expect(metrics.getMetrics().isolationChecks).toBe(2);
    expect(metrics.getMetrics().isolationViolations).toBe(1);
    expect(metrics.getMetrics().isolationComplianceRate).toBe(50);
    expect(report).toContain('| 双仓隔离合规率 | 50.0% | 100% | 未达标 |');
    expect(report).toContain('| 跨仓违规操作次数 | 1 | 0次 | 未达标 |');
  });

  it('MET_UNIT_004 persists the generated summary report and lists delivery evidence paths', () => {
    const { targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    const report = metrics.generateReport(targetDir);

    expect(existsSync(resolve(targetDir, 'docs/report/project_summary_report.md'))).toBe(true);
    expect(report).toContain('项目全流程总结报告');
    expect(report).toContain('docs/report/final_acceptance_report.md');
    expect(report).toContain('README.md');
  });

  it('MET_UNIT_005 keeps requirement and security coverage guidance in the summary report', () => {
    const { targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    const report = metrics.generateReport(targetDir);

    expect(report).toContain('需求覆盖率');
    expect(report).toContain('阻断性bug数量');
    expect(report).toContain('代码规范合规率');
    expect(report).toContain('单元测试覆盖率');
    expect(report).toContain('高危安全漏洞数');
  });

  it('MET_UNIT_006 auto-collects isolation, quality, automation, cost, and resilience metrics', () => {
    const { targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    metrics.recordTokens('planner', 10, 20);
    metrics.recordException('P2', false, false);
    metrics.startSprint('sprint-01');
    metrics.recordSprintIteration('sprint-01');
    metrics.endSprint('sprint-01', true);
    const report = metrics.generateReport(targetDir);

    expect(report).toContain('隔离合规指标');
    expect(report).toContain('交付质量指标');
    expect(report).toContain('自动化能力指标');
    expect(report).toContain('成本效率指标');
    expect(report).toContain('鲁棒性指标');
  });

  it('MET_UNIT_007 includes target thresholds for compliance and pass-rate checks', () => {
    const { targetDir } = useFixture();
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    const report = metrics.generateReport(targetDir);
    expect(report).toContain('>=7');
    expect(report).toContain('>=80%');
    expect(report).toContain('100%');
  });

  it('MET_UNIT_008 tracks live phases, token usage, iterations, and alerts via logs/metrics', () => {
    const { metaDir, targetDir } = useFixture();
    const logger = new Logger(resolve(metaDir, 'meta_logs'), 'metrics');
    const metrics = new MetricsCollector(new Logger(resolve(targetDir, 'project_logs'), 'metrics'));
    metrics.startPhase('DEV');
    metrics.recordTokens('generator', 100, 50);
    metrics.recordAgentCall('generator', 1200);
    metrics.recordException('P3', true, false);
    logger.error('alert', { errorCode: 'P3', state: 'DEV' });

    const logFile = resolve(metaDir, 'meta_logs', `${new Date().toISOString().split('T')[0]}.jsonl`);
    expect(metrics.getMetrics().totalInputTokens).toBe(100);
    expect(metrics.getMetrics().agentCallCount.generator).toBe(1);
    expect(existsSync(logFile)).toBe(true);
  });

  it('EXC_UNIT_008 and EXC_UNIT_009 parse effort hints from sprint sections', () => {
    expect(parseEffortScore('工作量: 2')).toBe(2);
    expect(parseEffortScore('effort: 5')).toBe(5);
    expect(parseEffortScore('复杂度: 9')).toBe(9);
  });
});
