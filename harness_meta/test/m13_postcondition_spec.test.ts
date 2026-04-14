/**
 * M13 阶段后置条件 — 测试分类: behavioral + anti-cheat
 *
 * 验证意图：覆盖每个关键 phase 的后置条件断言和失败阻断能力。
 * 包括：PLANNING/FINAL_ACCEPTANCE/RELEASE 后置条件验证、
 * 失败时不得创建 tag/不得推进状态/不得 merge 到 main。
 * 所有测试验证真实 Harness 行为和副作用，无源码字符串断言。
 */
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactValidator } from '../src/artifacts/validator.js';
import { Harness } from '../src/orchestrator/harness.js';
import { HarnessState } from '../src/types.js';
import type { HarnessConfig } from '../src/config.js';
import { createWorkspaceFixture, makeLogger, sampleStandardRequirement, sampleProductSpec, sampleSprintContract } from './helpers/fixtures.js';

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

describe('M13 phase post-condition hardening', () => {
  it('POST_UNIT_001 (behavioral) assertPostCondition throws for PROJECT_INIT when .git missing', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    // No .git directory → post-condition should throw
    expect(() => (harness as any).assertPostCondition(HarnessState.PROJECT_INIT))
      .toThrow(/Post-condition.*git repository not found/);
  });

  it('POST_UNIT_002 (behavioral) assertPostCondition throws for REQUIREMENT_PARSE when standard_requirement.md missing', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).assertPostCondition(HarnessState.REQUIREMENT_PARSE))
      .toThrow(/Post-condition.*standard_requirement\.md not found/);
  });

  it('POST_UNIT_003 (behavioral) assertPostCondition throws for PLANNING when design docs missing', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).assertPostCondition(HarnessState.PLANNING))
      .toThrow(/Post-condition.*planning doc.*not found/);
  });

  it('POST_UNIT_004 (anti-cheat) PLANNING post-condition detects docs with empty content', () => {
    const { targetDir, metaDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });

    // Create all 5 docs but with minimal content (shell documents)
    const shellDocs = ['product_spec.md', 'architecture_design.md', 'project_structure.md', 'code_standard.md', 'sprint_plan.md'];
    for (const doc of shellDocs) {
      writeFileSync(resolve(planDir, doc), `# ${doc}\n`, 'utf-8');
    }

    const results = validator.validatePlanningDocs(planDir);
    // Shell docs should fail validation (too short, missing sections)
    const invalidCount = results.filter(r => !r.valid).length;
    expect(invalidCount).toBeGreaterThan(0);
  });

  it('POST_UNIT_005 PLANNING post-condition passes with valid documents', () => {
    const { targetDir, metaDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });

    // Create valid documents
    writeFileSync(resolve(planDir, 'standard_requirement.md'), sampleStandardRequirement(), 'utf-8');
    writeFileSync(resolve(planDir, 'product_spec.md'), sampleProductSpec(), 'utf-8');
    writeFileSync(resolve(planDir, 'sprint_plan.md'), [
      '# Sprint Plan',
      '',
      '## Sprint sprint-01',
      '- Goal: Implement core feature',
      '- Deliverable: src/index.ts',
      '- Effort: 5',
      '',
      '## 里程碑',
      '- v0.1.0-plan-complete: sprint-01 complete',
    ].join('\n'), 'utf-8');

    // Validate product_spec specifically
    const productResult = validator.validateFile(resolve(planDir, 'product_spec.md'));
    expect(productResult.valid).toBe(true);

    // Validate sprint_plan specifically
    const sprintPlanResult = validator.validateFile(resolve(planDir, 'sprint_plan.md'));
    expect(sprintPlanResult.valid).toBe(true);
  });

  it('POST_UNIT_006 (behavioral) assertPostCondition throws for FINAL_ACCEPTANCE when report has non-passing conclusion', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const reportDir = resolve(targetDir, 'docs/report');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(resolve(reportDir, 'final_acceptance_report.md'), [
      '# Final Acceptance', '',
      '## 验收结果', '不通过', '',
      '## 验收详情', 'Missing core features.',
    ].join('\n'), 'utf-8');

    expect(() => (harness as any).assertPostCondition(HarnessState.FINAL_ACCEPTANCE))
      .toThrow(/Post-condition.*passing conclusion/);
  });

  it('POST_UNIT_007 (behavioral) assertPostCondition throws for RELEASE when README.md missing', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    expect(() => (harness as any).assertPostCondition(HarnessState.RELEASE))
      .toThrow(/Post-condition.*README\.md not found/);
  });

  it('POST_UNIT_008 (behavioral) assertPostCondition for SPRINT_MERGE checks milestone tag', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    // No milestone tag recorded → should throw
    expect(() => (harness as any).assertPostCondition(HarnessState.SPRINT_MERGE, { sprintId: 'sprint-01' }))
      .toThrow(/Post-condition.*milestone tag.*sprint-01/);
  });

  it('POST_UNIT_009 (behavioral) assertPostCondition passes RELEASE with valid README and summary', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    writeFileSync(resolve(targetDir, 'README.md'), [
      '# demo', '',
      '## 安装', 'npm install', '',
      '## 运行', 'npm start', '',
      '## 测试', 'npm test', '',
      '## 项目结构', '- src/',
    ].join('\n'), 'utf-8');
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/report/project_summary_report.md'), [
      '# 项目全流程总结报告', '',
      '## 一、项目基本信息', 'Demo project', '',
      '## 七、Sprint执行情况汇总', 'All done', '',
      '## 八、项目交付物清单', '- src/', '- README.md', '',
      '## 九、总结与归档说明', 'Archived.',
    ].join('\n'), 'utf-8');

    expect(() => (harness as any).assertPostCondition(HarnessState.RELEASE)).not.toThrow();
  });

  it('POST_UNIT_010 (anti-cheat) sprint contract with TBD exceeds limit', () => {
    const { targetDir, metaDir } = useFixture();
    const validator = new ArtifactValidator(makeLogger(resolve(metaDir, 'meta_logs')));

    const contractDir = resolve(targetDir, 'docs/sprint');
    mkdirSync(contractDir, { recursive: true });

    const badContract = sampleSprintContract().replace(
      '双方确认',
      'TBD 待确认 TBD 待确认 TBD 待确认',
    );
    const contractPath = resolve(contractDir, 'sprint_contract_sprint-01.md');
    writeFileSync(contractPath, badContract, 'utf-8');

    const result = validator.validateSprintContract(contractPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('TBD'))).toBe(true);
  });

  it('POST_UNIT_014 (behavioral) assertPostCondition passes when all planning docs are valid', () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(resolve(planDir, 'product_spec.md'), sampleProductSpec(), 'utf-8');
    writeFileSync(resolve(planDir, 'standard_requirement.md'), sampleStandardRequirement(), 'utf-8');
    writeFileSync(resolve(planDir, 'sprint_plan.md'), [
      '# Sprint Plan', '',
      '## Sprint sprint-01', '- Goal: test', '- Deliverable: src/index.ts', '- Effort: 5', '',
      '## 里程碑', '- v0.1.0: sprint-01',
    ].join('\n'), 'utf-8');
    writeFileSync(resolve(planDir, 'architecture_design.md'), [
      '# Architecture Design', '',
      '## 整体架构', 'Layered architecture', '',
      '## 技术栈', '- Runtime: Node.js', '- Language: TypeScript',
    ].join('\n'), 'utf-8');
    writeFileSync(resolve(planDir, 'project_structure.md'), [
      '# Project Structure', '',
      '## 目录结构', '- src/', '- test/',
    ].join('\n'), 'utf-8');
    writeFileSync(resolve(planDir, 'code_standard.md'), [
      '# Code Standard', '',
      '## 编码规范', '- Use TypeScript strict mode',
    ].join('\n'), 'utf-8');

    // Should NOT throw
    expect(() => (harness as any).assertPostCondition(HarnessState.PLANNING)).not.toThrow();
  });

  it('POST_UNIT_015 (behavioral) PLANNING post-condition failure blocks milestone tag creation and phase advance', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    (harness as any).stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    (harness as any).stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    (harness as any).stateMachine.transitionMeta(HarnessState.PLANNING);
    (harness as any).stateMachine.transitionProject(HarnessState.REQUIREMENT_PARSE);

    const planDir = resolve(targetDir, 'docs/plan');
    mkdirSync(planDir, { recursive: true });
    (harness as any).planner = {
      plan: vi.fn(async () => {
        writeFileSync(resolve(planDir, 'product_spec.md'), sampleProductSpec(), 'utf-8');
        writeFileSync(resolve(planDir, 'sprint_plan.md'), [
          '# Sprint Plan', '',
          '## Sprint sprint-01', '- Goal: test', '- Deliverable: src/index.ts', '- Effort: 5', '',
          '## 里程碑', '- v0.1.0-plan-complete: sprint-01',
        ].join('\n'), 'utf-8');
        writeFileSync(resolve(planDir, 'architecture_design.md'), [
          '# Architecture Design', '',
          '## 整体架构', 'Layered architecture', '',
          '## 技术栈', '- Runtime: Node.js', '- Language: TypeScript',
        ].join('\n'), 'utf-8');
        writeFileSync(resolve(planDir, 'project_structure.md'), [
          '# Project Structure', '',
          '## 目录结构', '- src/', '- test/',
        ].join('\n'), 'utf-8');
        writeFileSync(resolve(planDir, 'code_standard.md'), [
          '# Code Standard', '',
          '## 编码规范', '- Use TypeScript strict mode',
        ].join('\n'), 'utf-8');
      }),
    };

    const originalValidateFile = (harness as any).artifactValidator.validateFile.bind((harness as any).artifactValidator);
    let projectStructureChecks = 0;
    vi.spyOn((harness as any).artifactValidator, 'validateFile').mockImplementation((filePath: string) => {
      if (filePath.endsWith('project_structure.md')) {
        projectStructureChecks++;
        if (projectStructureChecks >= 2) {
          return {
            valid: false,
            file: filePath,
            errors: ['simulated post-condition failure'],
            warnings: [],
          };
        }
      }
      return originalValidateFile(filePath);
    });

    await expect((harness as any).planning(sampleStandardRequirement())).rejects.toThrow(
      /Post-condition: project_structure\.md failed validation/,
    );
    expect(await git.getTags()).not.toContain('v0.1.0-plan-complete');
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.PLANNING);
  });

  it('POST_UNIT_016 (behavioral) FINAL_ACCEPTANCE post-condition failure blocks release-candidate tagging', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');
    (harness as any).stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    (harness as any).stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    (harness as any).stateMachine.transitionMeta(HarnessState.PLANNING);
    (harness as any).stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
    (harness as any).stateMachine.completeSprint('sprint-01');

    mkdirSync(resolve(targetDir, 'docs/plan'), { recursive: true });
    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/plan/product_spec.md'), sampleProductSpec(), 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/plan/sprint_plan.md'), [
      '# Sprint Plan', '',
      '## Sprint sprint-01', '- Goal: released', '- Deliverable: src/index.ts', '- Effort: 5', '',
      '## 里程碑', '- v0.1.0-plan-complete: sprint-01',
    ].join('\n'), 'utf-8');
    writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), `# Final Acceptance Report

## 全量验收
- 版本候选: v1.0.0-release-candidate

## 验收范围
- docs/plan/product_spec.md

## 核心功能覆盖
- 已覆盖核心流程

## 质量与风险
- 无阻断发布问题

## 验收结论
- 结论: 通过，可发布

v1.0.0-release-candidate
`, 'utf-8');

    (harness as any).client = {
      chatWithTools: vi.fn(async () => {
        throw new Error('offline');
      }),
      getTokenUsage: vi.fn(() => ({ total: 0 })),
    };

    const originalIsPassing = (harness as any).isFinalAcceptanceReportPassing.bind(harness);
    let passChecks = 0;
    vi.spyOn(harness as any, 'isFinalAcceptanceReportPassing').mockImplementation((content: string) => {
      passChecks++;
      if (passChecks === 1) {
        return originalIsPassing(content);
      }
      return false;
    });

    await expect((harness as any).finalAcceptance()).rejects.toThrow(
      /Post-condition: final_acceptance_report\.md does not record a passing conclusion/,
    );
    expect(await git.getTags()).not.toContain('v1.0.0-release-candidate');
    expect((harness as any).stateMachine.getMetaState().currentState).toBe(HarnessState.FINAL_ACCEPTANCE);
  });

  it('POST_UNIT_017 (behavioral) RELEASE post-condition failure blocks merge to main and release tag creation', async () => {
    const { rootDir, metaDir, targetDir } = useFixture();
    const harness = new Harness(makeHarnessConfig(rootDir, metaDir, targetDir));
    (harness as any).initInfrastructure();

    const git = (harness as any).git;
    await git.initTargetRepo();
    await git.ensureBranch('dev');
    await git.checkout('dev');
    (harness as any).stateMachine.transitionMeta(HarnessState.PROJECT_INIT);
    (harness as any).stateMachine.transitionMeta(HarnessState.REQUIREMENT_PARSE);
    (harness as any).stateMachine.transitionMeta(HarnessState.PLANNING);
    (harness as any).stateMachine.transitionMeta(HarnessState.SPRINT_DISPATCH);
    (harness as any).stateMachine.transitionMeta(HarnessState.FINAL_ACCEPTANCE);
    (harness as any).stateMachine.transitionProject(HarnessState.FINAL_ACCEPTANCE);

    mkdirSync(resolve(targetDir, 'docs/report'), { recursive: true });
    writeFileSync(resolve(targetDir, 'docs/report/final_acceptance_report.md'), `# Final Acceptance Report

## 全量验收
- 版本候选: v1.0.0-release-candidate

## 验收范围
- docs/plan/product_spec.md

## 核心功能覆盖
- 已覆盖核心流程

## 质量与风险
- 无阻断发布问题

## 验收结论
- 结论: 通过，可发布

v1.0.0-release-candidate
`, 'utf-8');
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

    (harness as any).client = {
      chatWithTools: vi.fn(async () => {
        throw new Error('offline');
      }),
      getTokenUsage: vi.fn(() => ({ total: 0 })),
    };

    const originalReadmeComplete = (harness as any).isDeliveryReadmeComplete.bind(harness);
    let readmeChecks = 0;
    vi.spyOn(harness as any, 'isDeliveryReadmeComplete').mockImplementation((content: string) => {
      readmeChecks++;
      if (readmeChecks <= 2) {
        return originalReadmeComplete(content);
      }
      return false;
    });

    await expect((harness as any).release()).rejects.toThrow(
      /Post-condition: README\.md is incomplete after RELEASE/,
    );
    expect(await git.getCurrentBranch()).toBe('dev');
    expect(await git.getTags()).not.toContain('v1.0.0-release');
  });

});
