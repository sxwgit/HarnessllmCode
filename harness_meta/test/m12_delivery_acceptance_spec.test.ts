/**
 * M12 交付与最终验收 — 测试分类: anti-cheat + behavioral
 *
 * 验证意图：覆盖发布证据门禁的全部反作弊场景。
 * 包括：空壳 final acceptance 报告拒绝、空壳 README 拒绝、空壳 summary report 拒绝、
 * checkpoint 清理、README 自动生成、release evidence 验证。
 * 所有测试验证真实 ArtifactValidator 返回值或 Harness 行为，无源码字符串断言。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessConfig } from '../src/config.js';
import { Harness } from '../src/orchestrator/harness.js';
import { HarnessState } from '../src/types.js';
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

function makeHarnessConfig(rootDir: string, metaDir: string, targetDir: string): HarnessConfig {
  return {
    version: '0.1.0',
    llm: {
      baseURL: 'http://localhost:1234',
      apiKey: 'test-key',
      apiKeyEnvVar: 'TEST_API_KEY',
      model: 'test-model',
      maxTokens: 2048,
      temperature: 0,
    },
    thresholds: {
      maxRetries: 2,
      maxSprintIterations: 2,
      maxRollbacks: 1,
      maxNegotiationRounds: 2,
      evaluationPassScore: 7,
      evaluationMinDimensionScore: 6,
    },
    paths: {
      workspaceRoot: rootDir,
      ideaFile: resolve(targetDir, 'idea.md'),
      targetProject: targetDir,
      metaLogs: resolve(metaDir, 'meta_logs'),
    },
  };
}

function writeFinalAcceptanceReport(targetDir: string, conclusion = '通过'): void {
  mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
  writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), `# Final Acceptance Report

## 全量验收
- 版本候选: v1.0.0-release-candidate
- 验收方式: 全量检查

## 验收范围
- docs/plan/product_spec.md
- src/

## 核心功能覆盖
- 已覆盖核心流程与主要交互

## 质量与风险
- 当前无阻断发布问题

## 验收结论
- 结论: ${conclusion}

v1.0.0-release-candidate
`, 'utf-8');
}

describe('M12 delivery and final acceptance hardening', () => {
  it('DELIV_UNIT_001 rejects missing final acceptance evidence instead of auto-filling success', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), '# incomplete\n', 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();
    expect(() => (harness as any).validateFinalAcceptanceReportOrThrow('llm unavailable')).toThrow(
      'Final acceptance report missing or incomplete',
    );
  });

  it('DELIV_UNIT_001A rejects final acceptance reports without an explicit passing conclusion', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFinalAcceptanceReport(targetDir, '不通过');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();
    expect(() => (harness as any).validateFinalAcceptanceReportOrThrow()).toThrow(
      'Final acceptance report does not record a passing conclusion',
    );
  });

  it('DELIV_UNIT_001B rejects shell final acceptance reports that only contain section headings', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), `# Final Acceptance Report

## 全量验收

## 验收范围

## 核心功能覆盖

## 质量与风险

## 验收结论

v1.0.0-release-candidate
`, 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateFinalAcceptanceReportOrThrow()).toThrow(
      'Final acceptance report missing or incomplete',
    );
  });

  it('DELIV_UNIT_002 writes a deterministic README when delivery-doc generation is missing or incomplete', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/plan/product_spec.md'), '# Demo Project\n\n## 产品概述\nDemo app\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'package.json'), JSON.stringify({
      name: 'demo-project',
      scripts: { start: 'node src/index.js', test: 'vitest run' },
    }, null, 2), 'utf-8');
    writeFileSync(resolve(targetDir, 'src/index.js'), 'console.log("demo");\n', 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();
    (harness as any).ensureDeliveryReadme('llm unavailable');

    const readmePath = resolve(targetDir, 'README.md');
    const readme = readFileSync(readmePath, 'utf-8');
    expect(existsSync(readmePath)).toBe(true);
    expect(readme).toContain('# demo-project');
    expect(readme).toContain('## 安装');
    expect(readme).toContain('## 运行');
    expect(readme).toContain('## 测试');
    expect(readme).toContain('## 项目结构');
  });

  it('DELIV_UNIT_003 clears persisted checkpoints after successful completion cleanup', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();
    (harness as any).checkpointManager.save({
      id: 'cp-release',
      timestamp: '2026-04-08T00:00:00.000Z',
      state: HarnessState.RELEASE,
      currentSprintId: null,
      completedSprints: [],
      meta: { totalTokensUsed: 1, totalIterations: 1, exceptionsHandled: 0 },
      gitInfo: { currentBranch: 'main', lastCommit: 'abc123', tags: [] },
    });

    expect((harness as any).checkpointManager.getAll().length).toBe(1);
    (harness as any).clearResumeArtifacts();
    expect((harness as any).checkpointManager.getAll().length).toBe(0);
  });

  it('DELIV_UNIT_004 rejects release when README evidence is incomplete', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFinalAcceptanceReport(targetDir);
    writeFileSync(resolve(targetDir, 'README.md'), '# demo\n', 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/report/project_summary_report.md'), `# 项目全流程总结报告

## 一、项目基本信息
Demo project

## 七、Sprint执行情况汇总
All done

## 八、项目交付物清单
src/

## 九、总结与归档说明
Archived.
`, 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateReleaseEvidenceOrThrow()).toThrow(
      'Release evidence incomplete: README is missing or incomplete',
    );
  });

  it('DELIV_UNIT_004A rejects release when README only contains empty section shells', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFinalAcceptanceReport(targetDir, '通过，可发布');
    writeFileSync(resolve(targetDir, 'README.md'), `# demo

## 安装

## 运行

## 测试

## 项目结构
`, 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/report/project_summary_report.md'), `# 项目全流程总结报告

## 一、项目基本信息
Demo project

## 七、Sprint执行情况汇总
All done

## 八、项目交付物清单
src/

## 九、总结与归档说明
Archived
`, 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateReleaseEvidenceOrThrow()).toThrow(
      'Release evidence incomplete: README is missing or incomplete',
    );
  });

  it('DELIV_UNIT_005 rejects release when summary evidence is incomplete', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFinalAcceptanceReport(targetDir);
    writeFileSync(resolve(targetDir, 'README.md'), `# demo

## 安装
npm install

## 运行
npm run start

## 测试
npm test

## 项目结构
- src/
`, 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/report/project_summary_report.md'), '# partial summary\n', 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateReleaseEvidenceOrThrow()).toThrow(
      'Release evidence incomplete: project summary report missing sections',
    );
  });

  it('DELIV_UNIT_005A rejects release when summary report sections exist but have no substantive content', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    writeFinalAcceptanceReport(targetDir, '通过，可发布');
    writeFileSync(resolve(targetDir, 'README.md'), `# demo

## 安装
\`\`\`bash
npm install
\`\`\`

## 运行
\`\`\`bash
npm run start
\`\`\`

## 测试
\`\`\`bash
npm test
\`\`\`

## 项目结构
- src/
- docs/
`, 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/report/project_summary_report.md'), `# 项目全流程总结报告

## 一、项目基本信息

## 七、Sprint执行情况汇总

## 八、项目交付物清单

## 九、总结与归档说明
`, 'utf-8');

    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).validateReleaseEvidenceOrThrow()).toThrow(
      'Release evidence incomplete: project summary report missing sections',
    );
  });
});
