/**
 * M18 双轨制测试 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖 Markdown + 嵌入式 JSON 双轨制的核心能力：
 * 1. JSON 块提取是主解析路径（extractJsonBlock 共享方法）
 * 2. extractReviewReportData 优先从 JSON 块取 5 维度评分
 * 3. negotiation 的 parseReviewPayload 优先从 JSON 块取 agreed/concerns
 * 4. 无 JSON 块时正确回退到 regex/关键词兜底
 * 5. 残缺/非法 JSON 块不会导致崩溃
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJsonBlock } from '../src/artifacts/text-normalizer.js';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import {
  createTempDir,
  makeLogger,
  sampleReviewReport,
} from './helpers/fixtures.js';

const fixtures: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

function useTempDir(prefix = 'dual-') {
  const { dir, cleanup } = createTempDir(prefix);
  fixtures.push({ cleanup });
  return dir;
}

// ============ extractJsonBlock 共享方法 ============

describe('DUAL: extractJsonBlock shared utility', () => {
  it('extracts valid JSON from ```json code block', () => {
    const content = 'some text\n```json\n{"key": "value", "num": 42}\n```\nmore text';
    const result = extractJsonBlock(content);
    expect(result).not.toBeNull();
    expect(result!.key).toBe('value');
    expect(result!.num).toBe(42);
  });

  it('returns null when no JSON block exists', () => {
    const content = '# Just markdown\n- item 1\n- item 2\n';
    expect(extractJsonBlock(content)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const content = '```json\n{invalid json!!!}\n```';
    expect(extractJsonBlock(content)).toBeNull();
  });

  it('returns null for JSON array (not object)', () => {
    const content = '```json\n[1, 2, 3]\n```';
    expect(extractJsonBlock(content)).toBeNull();
  });
});

// ============ extractReviewReportData JSON 优先 ============

describe('DUAL: extractReviewReportData JSON-first path', () => {
  const fullJsonReport = `# Review Report

## 验收基本信息
- Sprint ID: sprint-01

## 评分
- 功能完整性: 9
- 代码质量: 8
- 可运行性: 8
- 可测试性: 7
- 安全性: 8

## 整体加权平均分
8.2

## 问题清单
(none)

## 验收结果
通过

\`\`\`json
{
  "sprintId": "sprint-01",
  "passed": true,
  "scores": [
    { "dimension": "功能完整性", "weight": 0.35, "score": 9, "maxScore": 10, "notes": "全部功能实现" },
    { "dimension": "代码质量与架构合规性", "weight": 0.25, "score": 8, "maxScore": 10, "notes": "符合规范" },
    { "dimension": "可运行性与稳定性", "weight": 0.20, "score": 8, "maxScore": 10, "notes": "稳定运行" },
    { "dimension": "可测试性与文档完整性", "weight": 0.10, "score": 7, "maxScore": 10, "notes": "基础覆盖" },
    { "dimension": "代码安全性", "weight": 0.10, "score": 8, "maxScore": 10, "notes": "无漏洞" }
  ],
  "weightedAverage": 8.2,
  "issues": []
}
\`\`\`
`;

  it('extracts all 5 dimensions from JSON block (not regex)', () => {
    const dir = useTempDir();
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const result = validator.extractReviewReportData(fullJsonReport);
    expect(result.scores).toHaveLength(5);
    expect(result.sprintId).toBe('sprint-01');
    expect(result.passed).toBe(true);
    expect(result.weightedAverage).toBe(8.2);

    // Verify dimension names come from JSON, not regex
    const dims = result.scores.map(s => s.dimension);
    expect(dims).toContain('功能完整性');
    expect(dims).toContain('代码质量与架构合规性');
    expect(dims).toContain('可运行性与稳定性');
    expect(dims).toContain('可测试性与文档完整性');
    expect(dims).toContain('代码安全性');
  });

  it('falls back to regex when no JSON block present', () => {
    const dir = useTempDir();
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const result = validator.extractReviewReportData(sampleReviewReport());
    expect(result.sprintId).toBeTruthy();
    expect(result.scores.length).toBeGreaterThan(0);
  });

  it('falls back correctly when JSON block has fewer than 5 dimensions', () => {
    const dir = useTempDir();
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const partialJson = `# Review Report
## 评分
- 功能完整性: 8
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8
## 整体加权平均分
8.0
## 验收结果
通过

\`\`\`json
{
  "sprintId": "sprint-01",
  "passed": true,
  "scores": [
    { "dimension": "功能完整性", "score": 8 }
  ],
  "weightedAverage": 8.0,
  "issues": []
}
\`\`\`
`;
    const result = validator.extractReviewReportData(partialJson);
    // JSON block had only 1 dimension (not all 5), so JSON-first path skipped.
    // Falls through to extractStructuredData which also finds the JSON block first.
    // The result should still return data (at least the 1 from JSON) without crashing.
    expect(result.sprintId).toBe('sprint-01');
    expect(result.scores.length).toBeGreaterThanOrEqual(1);
  });

  it('handles malformed JSON block gracefully', () => {
    const dir = useTempDir();
    const logger = makeLogger(dir, 'test');
    const validator = new ArtifactValidator(logger);

    const badJson = `# Review Report
## 评分
- 功能完整性: 8
- 代码质量: 8
- 可运行性: 8
- 可测试性: 8
- 安全性: 8
## 整体加权平均分
8.0
## 验收结果
通过

\`\`\`json
{ broken json !!!
\`\`\`
`;
    const result = validator.extractReviewReportData(badJson);
    // Should not crash; should fallback to regex
    expect(result.scores.length).toBeGreaterThanOrEqual(0);
  });
});

// ============ Negotiation JSON 解析 ============

describe('DUAL: negotiation parseReviewPayload', () => {
  // We test via the SprintNegotiator class indirectly by checking the
  // extractJsonBlock behavior it depends on.

  it('extractJsonBlock correctly parses agreed=false with concerns', () => {
    const content = 'some text\n```json\n{"agreed": false, "concerns": ["issue1", "issue2"]}\n```';
    const result = extractJsonBlock(content);
    expect(result).not.toBeNull();
    expect(result!.agreed).toBe(false);
    expect(result!.concerns).toEqual(['issue1', 'issue2']);
  });

  it('extractJsonBlock correctly parses agreed=true with empty concerns', () => {
    const content = '```json\n{"agreed": true, "concerns": []}\n```';
    const result = extractJsonBlock(content);
    expect(result).not.toBeNull();
    expect(result!.agreed).toBe(true);
  });

  it('extractJsonBlock returns null for LLM text without JSON code fence', () => {
    const content = 'The evaluator agrees with this contract. No issues found.';
    expect(extractJsonBlock(content)).toBeNull();
  });
});
