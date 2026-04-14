#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const harnessRoot = resolve(repoRoot, 'harness_meta');
const reportJsonPath = resolve(harnessRoot, '.tmp-vitest-report.json');
const reportDocPath = resolve(repoRoot, 'docs/测试用例执行报告.md');
const roadmapPath = resolve(repoRoot, 'docs/严格化改造进展与后续路线图.md');
const readmePath = resolve(repoRoot, 'README.md');

const coverageLabels = new Map([
  ['m01_m02_spec.test.ts', 'M01 铁律、M02 边界定义'],
  ['m03_m04_spec.test.ts', 'M03 架构契约、M04 状态机'],
  ['m05_git_spec.test.ts', 'M05 双 Git 治理'],
  ['m06_agents_spec.test.ts', 'M06 多 Agent 设计与执行合同'],
  ['m07_m08_spec.test.ts', 'M07 异常处理、M08 指标体系'],
  ['m09_m10_spec.test.ts', 'M09 模板规范、M10 版本/合规'],
  ['m11_resume_spec.test.ts', 'M11 断点续跑'],
  ['m12_delivery_acceptance_spec.test.ts', 'M12 交付与最终验收'],
  ['m13_postcondition_spec.test.ts', 'M13 阶段后置条件'],
  ['m14_structured_handoff_spec.test.ts', 'M14 结构化交接与反作弊'],
]);

function todayInShanghai() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
}

function runVitestJsonReport() {
  execFileSync(
    'npm',
    ['test', '--', '--reporter=json', '--outputFile=.tmp-vitest-report.json'],
    {
      cwd: harnessRoot,
      stdio: 'inherit',
    },
  );
}

function loadJsonReport() {
  if (!existsSync(reportJsonPath)) {
    throw new Error(`Missing vitest JSON report: ${reportJsonPath}`);
  }
  return JSON.parse(readFileSync(reportJsonPath, 'utf-8'));
}

function collectFileRows(report) {
  return report.testResults
    .map((entry) => {
      const file = basename(entry.name);
      const total = entry.assertionResults.length;
      const passed = entry.assertionResults.filter((item) => item.status === 'passed').length;
      const failed = entry.assertionResults.filter((item) => item.status === 'failed').length;
      return {
        file,
        label: coverageLabels.get(file) || '未分类',
        total,
        passed,
        failed,
        conclusion: failed === 0 ? '全通过' : '存在失败',
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

function buildTestReportMarkdown(date, summary, rows) {
  const tableRows = rows
    .map((row) => `| \`harness_meta/test/${row.file}\` | ${row.label} | ${row.total} | ${row.passed} | ${row.failed} | ${row.conclusion} |`)
    .join('\n');

  return `# 测试用例执行报告

更新时间：${date}

## 1. 执行信息

- 执行目录：\`${harnessRoot}\`
- 执行命令：\`npm test -- --reporter=json --outputFile=.tmp-vitest-report.json\`
- 结果口径：以本脚本最新一次全量 \`vitest\` 执行为准

## 2. 总体结论

当前全量测试已执行完毕，结果如下：

| 指标 | 数值 |
|---|---:|
| 测试文件数 | ${rows.length} |
| 通过文件数 | ${rows.filter((row) => row.failed === 0).length} |
| 失败文件数 | ${rows.filter((row) => row.failed > 0).length} |
| 测试用例总数 | ${summary.numTotalTests} |
| 通过用例数 | ${summary.numPassedTests} |
| 失败用例数 | ${summary.numFailedTests} |
| 总体结果 | ${summary.success ? 'passed' : 'failed'} |

## 3. 模块覆盖概览

| 测试文件 | 覆盖主题 | 总数 | 通过 | 失败 | 结论 |
|---|---|---:|---:|---:|---|
${tableRows}

## 4. 当前测试口径说明

本报告不再维护旧的手写统计数字。后续更新时遵循以下规则：

1. 只记录最新一次全量 \`npm test\` 的真实结果。
2. 测试文件数按实际 \`testResults\` 文件数统计。
3. 用例数按 JSON 报告中的 \`numTotalTests / numPassedTests / numFailedTests\` 统计。
4. 如果未重新执行全量测试，不应手工修改本报告中的结果数字。

## 5. 当前质量判断

从“测试是否能严格指导开发”这个目标看，当前测试体系已经进入以行为测试和反作弊测试为主的阶段，重点覆盖：

1. 核心 phase/FSM 门禁与副作用阻断
2. Git 治理与回滚可追溯性
3. Agent 调用合同与 evaluator 硬阈值
4. 结构化交接、交付证据与最终验收反作弊
5. 恢复链路、后置条件、异常升级与 metrics 数值校验
`;
}

function updateSingleLine(content, pattern, replacement) {
  if (!pattern.test(content)) {
    throw new Error(`Pattern not found while updating docs: ${pattern}`);
  }
  return content.replace(pattern, replacement);
}

function updateAuxiliaryDocs(date, rows, summary) {
  const suiteSummary = `\`${rows.length}\` 个测试文件、\`${summary.numPassedTests}/${summary.numTotalTests}\` 通过`;

  const roadmap = readFileSync(roadmapPath, 'utf-8');
  let nextRoadmap = roadmap;
  nextRoadmap = updateSingleLine(nextRoadmap, /更新时间：\d{4}-\d{2}-\d{2}/, `更新时间：${date}`);
  nextRoadmap = updateSingleLine(nextRoadmap, /3\. 当前测试结果为 `\d+` 个测试文件、`\d+\/\d+` 通过。/, `3. 当前测试结果为 ${suiteSummary}。`);
  writeFileSync(roadmapPath, nextRoadmap, 'utf-8');

  const readme = readFileSync(readmePath, 'utf-8');
  let nextReadme = readme;
  nextReadme = updateSingleLine(
    nextReadme,
    /截至 \d{4}-\d{2}-\d{2}，`harness_meta` 当前全量测试结果为 `\d+\/\d+` 通过。/,
    `截至 ${date}，\`harness_meta\` 当前全量测试结果为 \`${summary.numPassedTests}/${summary.numTotalTests}\` 通过。`,
  );
  writeFileSync(readmePath, nextReadme, 'utf-8');
}

function main() {
  const date = todayInShanghai();
  runVitestJsonReport();
  const report = loadJsonReport();
  const rows = collectFileRows(report);
  const markdown = buildTestReportMarkdown(date, report, rows);
  writeFileSync(reportDocPath, markdown, 'utf-8');
  updateAuxiliaryDocs(date, rows, report);

  if (existsSync(reportJsonPath)) {
    rmSync(reportJsonPath);
  }

  console.log(`Updated test docs with ${rows.length} files and ${report.numPassedTests}/${report.numTotalTests} passing tests.`);
}

main();
