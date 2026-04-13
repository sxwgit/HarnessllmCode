/**
 * Centralized registry for all keyword lists, dimension names, and section markers
 * used across the validation pipeline.
 *
 * Single source of truth — every entry has a canonical form plus optional aliases.
 * Consumers use the exported helpers for matching, which applies text normalization.
 */

import { normalizedIncludes, normalizeText } from './text-normalizer.js';

// ---- Evaluation Dimensions (shared by validator + harness) ----

export const EVALUATION_DIMENSIONS = [
  { canonical: '功能完整性', aliases: ['功能完整性'] },
  { canonical: '代码质量与架构合规性', aliases: ['代码质量与架构合规性', '代码质量'] },
  { canonical: '可运行性与稳定性', aliases: ['可运行性与稳定性', '可运行性'] },
  { canonical: '可测试性与文档完整性', aliases: ['可测试性与文档完整性', '可测试性'] },
  { canonical: '代码安全性', aliases: ['代码安全性', '安全性'] },
] as const;

// ---- Sprint Contract Section Keywords ----

export const SPRINT_CONTRACT_REQUIRED_SECTIONS = [
  'Sprint基本信息',
  '核心目标',
  '交付清单',
  '验收标准',
  '测试用例',
  '交付物',
  '双方确认',
] as const;

// ---- Review Report Section Keywords ----

export const REVIEW_REPORT_REQUIRED_SECTIONS = [
  '评分',
  '整体加权平均分',
  '问题清单',
  '修复要求',
  '验收结果',
] as const;

// ---- Negotiation Sentiment Keywords ----

export const NEGOTIATION_POSITIVE_KEYWORDS = [
  '同意', '通过', '认可', '合格', 'agree', 'approved', '可以', '没问题', '良好', '符合', '达标',
] as const;

export const NEGOTIATION_NEGATIVE_KEYWORDS = [
  '不同意', '不通过', '拒绝', 'reject', 'disagree', '有问题', '需要修改', '需要改进', '不符合',
] as const;

// ---- Feedback Parsing Keywords ----

export const FEEDBACK_SECTION_MARKERS = [
  '架构优化建议', '架构反馈', '架构级问题', 'Architecture Feedback',
] as const;

export const FEEDBACK_REVISION_KEYWORDS = ['架构修订', '需要修改架构'] as const;
export const FEEDBACK_ROLLBACK_KEYWORDS = ['需要回退', '架构级回退'] as const;

export const SEVERITY_CRITICAL_KEYWORDS = ['严重', 'critical'] as const;
export const SEVERITY_MAJOR_KEYWORDS = ['重要', 'major'] as const;

// ---- Final Acceptance Report Sections ----

export const FINAL_ACCEPTANCE_REQUIRED_SECTIONS = [
  '全量验收',
  '验收范围',
  '核心功能覆盖',
  '质量与风险',
  '验收结论',
  'v1.0.0-release-candidate',
] as const;

// ---- Delivery README Sections ----

export const DELIVERY_README_REQUIRED_SECTIONS = [
  '# ', '安装', '运行', '测试', '项目结构',
] as const;

// ---- Project Summary Sections ----

export const PROJECT_SUMMARY_REQUIRED_SECTIONS = [
  '项目基本信息',
  'Sprint执行情况汇总',
  '项目交付物清单',
  '总结与归档说明',
] as const;

// ---- Helper Functions ----

/**
 * Check if content contains the given keyword using normalized matching.
 */
export function matchAnyKeyword(
  content: string,
  keywords: readonly string[],
  caseInsensitive = false,
): boolean {
  return keywords.some(k => normalizedIncludes(content, k, caseInsensitive));
}

/**
 * Build a regex alternation string from dimension aliases for table-pattern matching.
 * e.g. "功能完整性|代码质量与架构合规性|代码质量|..."
 */
export function dimensionAlternation(): string {
  return EVALUATION_DIMENSIONS
    .flatMap(d => d.aliases)
    .map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

/**
 * Build a normalized regex pattern string from dimension aliases.
 * Uses normalizeText to strip whitespace so patterns match regardless of spacing.
 */
export function dimensionNormalizedAlternation(): string {
  return EVALUATION_DIMENSIONS
    .flatMap(d => d.aliases)
    .map(alias => {
      const normalized = normalizeText(alias);
      return normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('|');
}
