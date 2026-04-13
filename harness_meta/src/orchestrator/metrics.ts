import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../logger/index.js';
import { IsolationMonitor } from '../isolation/monitor.js';

export interface MetricsData {
  // Timing
  startTime: string;
  endTime: string | null;
  phaseDurations: Record<string, number>; // phase → ms

  // Token usage
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensByAgent: Record<string, { input: number; output: number }>;

  // Sprint metrics
  totalSprints: number;
  completedSprints: number;
  failedSprints: number;
  sprintIterations: Map<string, number>; // sprintId → iteration count
  sprintDurations: Map<string, number>;   // sprintId → ms

  // Negotiation metrics
  totalNegotiationRounds: number;
  negotiationRoundsBySprint: Map<string, number>;

  // Exception metrics
  totalExceptions: number;
  exceptionsByLevel: Record<string, number>;
  selfHealedExceptions: number;
  exceptionUpgrades: number;

  // Quality metrics
  averageEvaluationScore: number;
  firstPassRate: number; // sprints passing on first try

  // Agent metrics
  agentCallCount: Record<string, number>;
  agentTotalDuration: Record<string, number>;

  // Isolation metrics (from IsolationMonitor)
  isolationChecks: number;
  isolationViolations: number;
  isolationComplianceRate: number;
}

export class MetricsCollector {
  private data: MetricsData;
  private logger: Logger;
  private currentPhaseStart: number | null = null;
  private currentPhaseName: string | null = null;
  private currentSprintStart: number | null = null;
  private currentSprintId: string | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
    this.data = {
      startTime: new Date().toISOString(),
      endTime: null,
      phaseDurations: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensByAgent: {},
      totalSprints: 0,
      completedSprints: 0,
      failedSprints: 0,
      sprintIterations: new Map(),
      sprintDurations: new Map(),
      totalNegotiationRounds: 0,
      negotiationRoundsBySprint: new Map(),
      totalExceptions: 0,
      exceptionsByLevel: {},
      selfHealedExceptions: 0,
      exceptionUpgrades: 0,
      averageEvaluationScore: 0,
      firstPassRate: 0,
      agentCallCount: {},
      agentTotalDuration: {},
      isolationChecks: 0,
      isolationViolations: 0,
      isolationComplianceRate: 100,
    };
  }

  // ============ Phase Tracking ============

  startPhase(phase: string): void {
    this.currentPhaseName = phase;
    this.currentPhaseStart = Date.now();
    this.logger.debug('Phase started', { phase });
  }

  endPhase(phase: string): void {
    if (this.currentPhaseStart && this.currentPhaseName === phase) {
      this.data.phaseDurations[phase] = Date.now() - this.currentPhaseStart;
      this.currentPhaseStart = null;
      this.currentPhaseName = null;
    }
  }

  // ============ Sprint Tracking ============

  startSprint(sprintId: string): void {
    this.currentSprintId = sprintId;
    this.currentSprintStart = Date.now();
    this.data.totalSprints++;
    this.data.sprintIterations.set(sprintId, 0);
    this.logger.info('Sprint started', { sprintId });
  }

  endSprint(sprintId: string, success: boolean): void {
    if (this.currentSprintStart && this.currentSprintId === sprintId) {
      this.data.sprintDurations.set(sprintId, Date.now() - this.currentSprintStart);
      this.currentSprintStart = null;
      this.currentSprintId = null;
    }

    if (success) {
      this.data.completedSprints++;
    } else {
      this.data.failedSprints++;
    }
  }

  recordSprintIteration(sprintId: string): void {
    const current = this.data.sprintIterations.get(sprintId) || 0;
    this.data.sprintIterations.set(sprintId, current + 1);
  }

  // ============ Token Tracking ============

  recordTokens(agent: string, input: number, output: number): void {
    this.data.totalInputTokens += input;
    this.data.totalOutputTokens += output;

    if (!this.data.tokensByAgent[agent]) {
      this.data.tokensByAgent[agent] = { input: 0, output: 0 };
    }
    this.data.tokensByAgent[agent].input += input;
    this.data.tokensByAgent[agent].output += output;
  }

  // ============ Negotiation Tracking ============

  recordNegotiation(sprintId: string, rounds: number): void {
    this.data.totalNegotiationRounds += rounds;
    this.data.negotiationRoundsBySprint.set(sprintId, rounds);
  }

  // ============ Exception Tracking ============

  recordException(level: string, selfHealed: boolean, upgraded: boolean): void {
    this.data.totalExceptions++;
    this.data.exceptionsByLevel[level] = (this.data.exceptionsByLevel[level] || 0) + 1;
    if (selfHealed) this.data.selfHealedExceptions++;
    if (upgraded) this.data.exceptionUpgrades++;
  }

  // ============ Agent Tracking ============

  recordAgentCall(agent: string, durationMs: number): void {
    this.data.agentCallCount[agent] = (this.data.agentCallCount[agent] || 0) + 1;
    this.data.agentTotalDuration[agent] = (this.data.agentTotalDuration[agent] || 0) + durationMs;
  }

  // ============ Quality Tracking ============

  recordEvaluationScore(score: number): void {
    const count = Object.keys(this.data.phaseDurations).length || 1;
    this.data.averageEvaluationScore =
      (this.data.averageEvaluationScore * (count - 1) + score) / count;
  }

  // ============ Isolation Tracking ============

  updateIsolationMetrics(monitor: IsolationMonitor): void {
    const metrics = monitor.getMetrics();
    this.data.isolationChecks = metrics.totalChecks;
    this.data.isolationViolations = metrics.violations;
    this.data.isolationComplianceRate = metrics.complianceRate;
  }

  // ============ Reporting ============

  finalize(): void {
    this.data.endTime = new Date().toISOString();

    // Calculate first pass rate
    let firstPassCount = 0;
    for (const [, iterations] of this.data.sprintIterations) {
      if (iterations <= 1) firstPassCount++;
    }
    this.data.firstPassRate = this.data.totalSprints > 0
      ? (firstPassCount / this.data.totalSprints) * 100
      : 0;
  }

  getMetrics(): MetricsData {
    return { ...this.data };
  }

  /**
   * Generate the project summary report
   */
  generateReport(targetDir: string): string {
    this.finalize();
    const d = this.data;

    const sprintRows = Array.from(this.data.sprintIterations.entries())
      .map(([id, iter]) => {
        const duration = this.data.sprintDurations.get(id);
        return `| ${id} | (见Sprint合同) | ${iter} | ${(duration! / 1000 / 60).toFixed(1)}min | ${iter <= 1 ? '通过' : '修复后通过'} |`;
      })
      .join('\n');

    const totalMs = d.endTime
      ? new Date(d.endTime).getTime() - new Date(d.startTime).getTime()
      : 0;

    const report = `# 项目全流程总结报告

## 一、项目基本信息
- **项目名称**: (参见 docs/plan/product_spec.md)
- **核心需求概述**: (参见 docs/plan/product_spec.md)
- 项目启动时间: ${d.startTime}
- 项目交付时间: ${d.endTime || '进行中'}
- 全流程总耗时: ${(totalMs / 1000 / 60).toFixed(1)} 分钟

## 二、隔离合规指标
| 指标名称 | 实际值 | 目标值 | 达标情况 |
|----------|--------|--------|----------|
| 双仓隔离合规率 | ${d.isolationComplianceRate.toFixed(1)}% | 100% | ${d.isolationComplianceRate >= 100 ? '达标' : '未达标'} |
| 跨仓违规操作次数 | ${d.isolationViolations} | 0次 | ${d.isolationViolations === 0 ? '达标' : '未达标'} |

## 三、交付质量指标
| 指标名称 | 实际值 | 目标值 | 达标情况 |
|----------|--------|--------|----------|
| Sprint验收平均分 | ${d.averageEvaluationScore.toFixed(1)} | >=7 | ${d.averageEvaluationScore >= 7 ? '达标' : '未达标'} |
| Sprint一次通过率 | ${d.firstPassRate.toFixed(1)}% | >=80% | ${d.firstPassRate >= 80 ? '达标' : '未达标'} |

## 四、自动化能力指标
| 指标名称 | 实际值 | 目标值 | 达标情况 |
|----------|--------|--------|----------|
| 完成Sprint数 | ${d.completedSprints}/${d.totalSprints} | 全部 | ${d.completedSprints === d.totalSprints ? '达标' : '未达标'} |
| 失败Sprint数 | ${d.failedSprints} | 0次 | ${d.failedSprints === 0 ? '达标' : '未达标'} |
| 单Sprint平均迭代次数 | ${this.avgIterations().toFixed(1)} | <=2次 | ${this.avgIterations() <= 2 ? '达标' : '未达标'} |

## 五、成本效率指标
| 指标名称 | 实际值 |
|----------|--------|
| 总Token消耗 | ${d.totalInputTokens + d.totalOutputTokens} (输入: ${d.totalInputTokens}, 输出: ${d.totalOutputTokens}) |
| Token消耗分Agent明细 | ${Object.entries(d.tokensByAgent).map(([a, t]) => `${a}: ${t.input + t.output}`).join(', ')} |
| 协商平均轮次 | ${d.totalSprints > 0 ? (d.totalNegotiationRounds / d.totalSprints).toFixed(1) : 'N/A'} |

## 六、鲁棒性指标
| 指标名称 | 实际值 | 目标值 | 达标情况 |
|----------|--------|--------|----------|
| 总异常数 | ${d.totalExceptions} | - | - |
| 异常自愈率 | ${d.totalExceptions > 0 ? ((d.selfHealedExceptions / d.totalExceptions) * 100).toFixed(1) : 'N/A'}% | >=95% | ${d.totalExceptions === 0 || d.selfHealedExceptions / d.totalExceptions >= 0.95 ? '达标' : '未达标'} |
| 异常升级次数 | ${d.exceptionUpgrades} | - | - |

## 七、Sprint执行情况汇总
| Sprint ID | 核心目标 | 迭代次数 | 耗时 | 结果 |
|-----------|----------|----------|------|------|
${sprintRows || '| (无) | | | | |'}

## 八、需求覆盖率
| 指标名称 | 说明 |
|----------|------|
| 需求覆盖率 | 基于Sprint合同功能点实现情况统计（详见各Sprint验收报告） |
| 阻断性bug数量 | 见最终验收报告 |
| 代码规范合规率 | 基于Evaluator评分统计 |
| 单元测试覆盖率 | 基于Evaluator评分统计 |
| 高危安全漏洞数 | 基于Evaluator安全扫描结果 |

## 九、项目交付物清单
| 交付物类型 | 交付物名称 | 存放路径 |
|------------|------------|----------|
| 核心代码 | 项目全量业务代码 | src/ |
| 设计文档 | 产品规格说明书 | docs/plan/product_spec.md |
| 设计文档 | 架构设计文档 | docs/plan/architecture_design.md |
| 设计文档 | Sprint计划文档 | docs/plan/sprint_plan.md |
| 验收报告 | 全量Sprint验收报告 | docs/sprint/ |
| 验收报告 | 全量验收报告 | docs/report/final_acceptance_report.md |
| 总结报告 | 项目全流程总结报告 | docs/report/project_summary_report.md |
| 交付文档 | 项目使用说明 (README.md) | README.md |
| 自检报告 | Generator自检查报告 | docs/sprint/self_check_report_*.md |

## 十、人工介入记录
| 介入次数 | 说明 |
|----------|------|
| 全流程人工介入次数 | 统计自ManualIntervention记录 |

## 十一、各阶段耗时
| 阶段 | 耗时(ms) |
|------|----------|
${Object.entries(d.phaseDurations).map(([p, ms]) => `| ${p} | ${ms} |`).join('\n')}

## 十二、全流程问题复盘与根因分析

> 注：本章节基于异常归档（Exception Archive）生成，请结合项目日志中的异常记录进行复盘。

| 异常级别 | 发生次数 | 自愈成功次数 | 典型根因 | 改进措施 |
|----------|----------|-------------|----------|----------|
${d.totalExceptions === 0
  ? '| (无异常记录) | - | - | - | - |'
  : Object.entries(d.exceptionsByLevel)
      .map(([level, count]) => `| ${level} | ${count} | ${d.selfHealedExceptions} | (详见日志) | (详见日志) |`)
      .join('\n')}

## 十三、总结与归档说明

- **Git仓库版本**: main 分支最新提交 (v1.0.0-release Tag)
- **发布 Tag**: v1.0.0-release
- **归档路径**: ${targetDir}
- **项目状态**: ${d.completedSprints === d.totalSprints ? '全部Sprint完成，项目交付成功' : '部分Sprint未完成，需人工介入'}
`;

    // Write to target project
    writeFileSync(resolve(targetDir, 'docs/report/project_summary_report.md'), report, 'utf-8');
    return report;
  }

  private avgIterations(): number {
    const arr = Array.from(this.data.sprintIterations.values());
    return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }
}
