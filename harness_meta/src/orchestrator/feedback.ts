import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../logger/index.js';
import { normalizedIncludes } from '../artifacts/text-normalizer.js';

export interface ArchitectureFeedback {
  id: string;
  timestamp: string;
  sprintId: string;
  issues: {
    severity: 'critical' | 'major' | 'minor';
    component: string;
    description: string;
    impact: string;
    suggestion: string;
  }[];
  requiresArchitectureRevision: boolean;
  requiresRollback: boolean;
}

/**
 * Architecture Reverse Feedback Channel
 *
 * Allows Evaluator to send architecture-level feedback back to Planner
 * when design defects are discovered during Sprint development/evaluation.
 */
export class FeedbackChannel {
  private targetDir: string;
  private logger: Logger;
  private pendingFeedback: ArchitectureFeedback[] = [];

  constructor(targetDir: string, logger: Logger) {
    this.targetDir = targetDir;
    this.logger = logger;
  }

  /**
   * Submit feedback from Evaluator about architecture issues
   */
  submitFeedback(feedback: ArchitectureFeedback): void {
    this.pendingFeedback.push(feedback);

    // Persist feedback report
    const reportPath = resolve(
      this.targetDir,
      `docs/sprint/architecture_feedback_${feedback.sprintId}.md`,
    );

    const report = this.generateFeedbackReport(feedback);
    writeFileSync(reportPath, report, 'utf-8');

    this.logger.warn('Architecture feedback submitted', {
      feedbackId: feedback.id,
      sprintId: feedback.sprintId,
      issueCount: feedback.issues.length,
      requiresRevision: feedback.requiresArchitectureRevision,
      requiresRollback: feedback.requiresRollback,
    });
  }

  /**
   * Parse architecture feedback from an evaluation report
   */
  parseFromEvaluationReport(reportContent: string, sprintId: string): ArchitectureFeedback | null {
    // Extract architecture feedback section
    const feedbackSection = this.extractFeedbackSection(reportContent);
    if (!feedbackSection) return null;

    const issues = this.parseIssues(feedbackSection);
    const requiresArchitectureRevision = normalizedIncludes(feedbackSection, '架构修订') || normalizedIncludes(feedbackSection, '需要修改架构');
    const requiresRollback = normalizedIncludes(feedbackSection, '需要回退') || normalizedIncludes(feedbackSection, '架构级回退');

    const feedback: ArchitectureFeedback = {
      id: `FB-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sprintId,
      issues,
      requiresArchitectureRevision,
      requiresRollback,
    };

    if (feedback.issues.length === 0 || (!requiresArchitectureRevision && !requiresRollback)) return null;
    return feedback;
  }

  /**
   * Get pending feedback for Planner to consume
   */
  getPendingFeedback(): ArchitectureFeedback[] {
    return [...this.pendingFeedback];
  }

  /**
   * Clear feedback after Planner has processed it
   */
  clearFeedback(ids: string[]): void {
    this.pendingFeedback = this.pendingFeedback.filter(f => !ids.includes(f.id));
    this.logger.info('Architecture feedback cleared', { count: ids.length });
  }

  /**
   * Check if there's any feedback requiring architecture revision
   */
  hasCriticalFeedback(): boolean {
    return this.pendingFeedback.some(f => f.requiresArchitectureRevision);
  }

  /**
   * Check if there's any feedback requiring rollback
   */
  hasRollbackRequest(): boolean {
    return this.pendingFeedback.some(f => f.requiresRollback);
  }

  private extractFeedbackSection(report: string): string | null {
    const lines = report.split('\n');
    const markers = ['架构优化建议', '架构反馈', '架构级问题', 'Architecture Feedback'];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const isHeading = /^##+\s+/.test(line);
      const containsMarker = markers.some(marker => normalizedIncludes(line, marker));
      if (isHeading && containsMarker) {
        const section: string[] = [lines[i]];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^##+\s+/.test(lines[j].trim())) break;
          section.push(lines[j]);
        }
        return section.join('\n');
      }
    }
    return null;
  }

  private parseIssues(section: string): ArchitectureFeedback['issues'] {
    const issues = this.parseTableIssues(section);
    if (issues.length > 0) return issues;

    const bulletIssues: ArchitectureFeedback['issues'] = [];
    const lines = section.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Detect severity
      let severity: ArchitectureFeedback['issues'][0]['severity'] = 'minor';
      if (normalizedIncludes(trimmed, '严重') || normalizedIncludes(trimmed, 'critical', true)) severity = 'critical';
      else if (normalizedIncludes(trimmed, '重要') || normalizedIncludes(trimmed, 'major', true)) severity = 'major';

      if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        bulletIssues.push({
          severity,
          component: 'architecture',
          description: trimmed.replace(/^[-*\d.)\s]+/, ''),
          impact: 'Affects downstream Sprint development',
          suggestion: 'Requires Planner review and architecture revision',
        });
      }
    }

    return bulletIssues;
  }

  private parseTableIssues(section: string): ArchitectureFeedback['issues'] {
    const issues: ArchitectureFeedback['issues'] = [];
    const lines = section.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) continue;
      if (normalizedIncludes(trimmed, '严重程度') || trimmed.includes('------')) continue;

      const columns = trimmed.split('|').map(part => part.trim()).filter(Boolean);
      if (columns.length < 6) continue;

      const severityText = columns[1];
      const severity = normalizedIncludes(severityText, '严重')
        ? 'critical'
        : normalizedIncludes(severityText, '重要')
          ? 'major'
          : 'minor';

      issues.push({
        severity,
        component: columns[2],
        description: columns[3],
        impact: columns[4],
        suggestion: columns[5],
      });
    }

    return issues;
  }

  private generateFeedbackReport(feedback: ArchitectureFeedback): string {
    const severityLabel = (s: string) => {
      switch (s) {
        case 'critical': return '严重';
        case 'major': return '重要';
        default: return '轻微';
      }
    };

    return `# 架构优化反馈报告

## 基本信息
- 反馈ID: ${feedback.id}
- 时间: ${feedback.timestamp}
- 触发Sprint: ${feedback.sprintId}
- 是否需要架构修订: ${feedback.requiresArchitectureRevision ? '是' : '否'}
- 是否需要回退: ${feedback.requiresRollback ? '是' : '否'}

## 架构问题清单

| 序号 | 严重程度 | 组件 | 问题描述 | 影响 | 建议 |
|------|----------|------|----------|------|------|
${feedback.issues.map((issue, i) =>
  `| ${i + 1} | ${severityLabel(issue.severity)} | ${issue.component} | ${issue.description} | ${issue.impact} | ${issue.suggestion} |`,
).join('\n')}

## 反馈来源
- Evaluator Agent
- 自动检测于验收评估阶段
`;
  }
}
