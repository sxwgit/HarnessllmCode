# Harness Framework 代码审计报告

**审计对象**: `harness_meta/` 全部源代码
**审计依据**: `docs/framework.md` v3.1 元程序/程序全隔离修正版
**审计时间**: 2026-04-06
**审计人**: QA Agent (独立代码审查)

---

## 一、审计总结

### 1.1 总体评价

| 维度 | 得分(10) | 说明 |
|------|----------|------|
| 架构完整性 | 8.5 | 分层架构基本对齐文档，1核3体4层核心模块齐全 |
| 铁则合规性 | 7.0 | 多数铁则已实现，部分存在落地偏差或缺失 |
| 安全隔离性 | 7.5 | 双仓隔离核心逻辑到位，但存在边界遗漏 |
| 异常鲁棒性 | 8.0 | P0-P4分级+自优化+根因归档基本完整 |
| 可测试性 | 3.0 | 零单元测试覆盖，仅有一个API连通性测试文件 |
| 产物规范性 | 7.0 | Schema验证框架已搭建，但抽取逻辑过于宽松 |
| 状态机合规 | 7.5 | 16个状态全部枚举，流转基本正确，但恢复逻辑有缺陷 |
| 可运维性 | 6.5 | 日志、指标、检查点已实现，但缺少运行时监控告警 |

### 1.2 问题统计

| 严重等级 | 数量 | 说明 |
|----------|------|------|
| **阻断级** (P0) | 5 | 违反框架铁则，必须修复 |
| **严重级** (P1) | 8 | 核心功能缺失或实现偏差 |
| **一般级** (P2) | 12 | 功能不完善，影响健壮性 |
| **提示级** (P3) | 7 | 优化建议 |

---

## 二、阻断级问题 (P0)

### P0-01: 零单元测试覆盖，严重违反框架铁则第7条

**框架铁则**: "99%的开发、迭代、排障、回退动作必须由框架自主完成"
**文档要求** (8.1-8): "单元测试覆盖率 >= 80%"
**文档要求** (8.2): "全流程效果度量指标"需要可量化

**实际情况**:
- 项目中 `**/*.test.ts` 匹配结果为空（0个测试文件）
- `**/*.spec.ts` 匹配结果为空
- 仅有 `src/test_api.ts` 是一个非标准的API连通性测试，不含断言框架
- `package.json` 中没有配置 `test` 脚本，没有安装任何测试框架（如 vitest, jest, mocha）

**影响**: 框架自身代码质量无法验证，核心模块（隔离监控、Git管控、状态机、异常处理、回滚管理）的正确性完全依赖人工审查。

**涉及文件**: `package.json`, 整个 `src/` 目录

---

### P0-02: ArtifactValidator 的结构化数据抽取逻辑形同虚设

**文档要求** (铁则2): "结构化产物唯一交接铁则"
**文档要求** (九): "所有智能体必须严格按照模板输出，严禁调整章节顺序、缺失必填模块"

**实际情况** (`src/artifacts/validator.ts:245-325`):
`extractStructuredData()` 方法从 Markdown 中提取结构化数据时，大量关键字段使用**空值/硬编码默认值**回退：

```typescript
// ArchitectureDesign 提取 - 几乎全是空值
case 'ArchitectureDesign': {
  return {
    overallArchitecture: this.extractSection(content, '整体架构') || '',
    layers: [],          // 永远为空数组
    coreModules: [],     // 永远为空数组
    dataModels: [],      // 永远为空数组
    techStack: {
      runtime: 'unknown',    // 硬编码
      language: 'unknown',   // 硬编码
      frameworks: {},
      devTools: [],
    },
  };
}

// SprintPlan 提取 - 完全为空
case 'SprintPlan': {
  return {
    sprints: [],     // 永远为空数组
    milestones: [],  // 永远为空数组
  };
}

// ReviewReport 提取
case 'ReviewReport': {
  return {
    sprintId: '',              // 永远为空
    passed: content.includes('通过') && !content.includes('不通过'),  // 误判风险极高
    scores: [],                // 永远为空
    weightedAverage: 0,        // 永远为0
    issues: [],                // 永远为空
  };
}
```

**影响**: Zod Schema 定义了严格的必填字段，但提取器几乎全部返回空值，导致 Zod 验证必然失败或因 `.optional()` 绕过。Schema 验证形同虚设，产物质量把关完全失效。

**涉及文件**: `src/artifacts/validator.ts:245-325`, `src/artifacts/schemas.ts`

---

### P0-03: 需求解析阶段未按文档执行，缺少完整性校验与结构化产物输出

**文档要求** (四-REQUIREMENT_PARSE):
1. "读取目标程序根目录下的 idea.md，执行需求完整性校验"
2. "转换为标准化需求文档 standard_requirement.md"
3. "标准化需求文档包含所有必填模块"
4. "需求缺失核心信息，触发需求补全提示，连续3次补全失败，进入人工介入状态"

**实际情况** (`src/orchestrator/harness.ts:406-452`):

- 需求解析使用 `generateWithSystem()` 做一次 LLM 调用，传入一个简短的 system prompt（约8行），未引用 `prompts/` 目录下的任何专用 Prompt 模板
- 没有执行需求完整性校验 — `validateFile()` 的校验结果仅打印 warning，不阻断流程
- 没有实现"需求补全提示"机制 — 缺失核心信息时直接继续，不触发迭代补全
- 生成的 `standard_requirement.md` 格式完全依赖 LLM 输出质量，无强制 Schema 约束

**影响**: 需求解析质量无保障，后续 Planner/Gateway 的设计基于可能不完整的需求，影响全局质量。

**涉及文件**: `src/orchestrator/harness.ts:406-452`

---

### P0-04: 合同协商中 Evaluator 与 Generator 共享同一 toolRegistry 实例

**文档铁则** (铁则1): "代码生成与质量评估彻底解耦，分别由独立智能体负责"
**文档铁则** (铁则10): "严禁同一智能体既做代码生成又做验收评估"

**实际情况** (`src/orchestrator/negotiation.ts:26-42`, `src/orchestrator/harness.ts:101-104`):
```typescript
// harness.ts:101-104 — 三个Agent共享同一个 toolRegistry
this.planner = new PlannerAgent(this.client, toolRegistry);
this.generator = new GeneratorAgent(this.client, toolRegistry, this.targetDir);
this.evaluator = new EvaluatorAgent(this.client, toolRegistry);

// negotiation.ts:33-34 — 协商器直接引用共享实例
this.generator = generator;
this.evaluator = evaluator;
```

虽然代码注释声称 "S-04 fix: Uses INDEPENDENT GeneratorAgent and EvaluatorAgent instances"，但三个 Agent 实际上共享了同一个 `LLMClient` 实例和同一个 `ToolRegistry` 实例。这不是真正的独立实例 — 它们共享相同的连接状态、token 计数器、工具执行上下文。

**影响**: 若一个 Agent 的工具调用产生副作用（如修改文件），另一个 Agent 可能看到中间状态。此外，共享 `LLMClient` 意味着 token 统计无法按 Agent 独立追踪。

**涉及文件**: `src/orchestrator/harness.ts:59,97-104`, `src/orchestrator/negotiation.ts:33-34`

---

### P0-05: 状态机恢复逻辑存在严重缺陷 — shouldSkipPhase 对 Sprint 子状态处理不正确

**文档要求** (四): "断点续跑快照管理" — 断点恢复后应精确到中断的具体 Sprint

**实际情况** (`src/orchestrator/harness.ts:972-1007`):
```typescript
private shouldSkipPhase(checkpointState, currentPhase): boolean {
  const sprintSubStates = [
    HarnessState.SPRINT_NEGOTIATION,
    HarnessState.DEV,
    HarnessState.PRE_EVALUATION,
    HarnessState.EVALUATION,
    HarnessState.SPRINT_MERGE,
  ];
  // 如果检查点在任何 Sprint 子状态，直接跳过整个 SPRINT_DISPATCH 阶段！
  if (sprintSubStates.includes(checkpointState) && currentPhase === HarnessState.SPRINT_DISPATCH) {
    return true;
  }
  return false;
}
```

当检查点处于 Sprint 子状态（如 `DEV`、`EVALUATION`）时，`shouldSkipPhase` 会**跳过整个 Sprint 循环**，而不是恢复到中断的具体 Sprint。这意味着：
- 如果在第3个 Sprint 的 EVALUATION 阶段崩溃，恢复后会跳过所有剩余 Sprint
- 检查点保存的 `completedSprints` 信息未被用来精确恢复

**影响**: 断点续跑功能形同虚设，Sprint 中途崩溃后无法正确恢复。

**涉及文件**: `src/orchestrator/harness.ts:972-1007`

---

## 三、严重级问题 (P1)

### P1-01: System Prompt 未纳入元程序 Git 版本管控

**文档要求** (6.1-1): "所有智能体的 System Prompt 均纳入元程序 Git 版本管控，版本号与框架版本一致"

**实际情况**: `prompts/` 目录下有3个 Prompt 文件（planner_system.md, generator_system.md, evaluator_system.md），但：
- Prompt 文件中没有版本号标识
- 没有与框架版本 `0.1.0` 关联
- 没有变更日志记录
- `harness_config.json` 中没有 Prompt 版本配置项

**涉及文件**: `prompts/*.md`, `harness_config.json`

---

### P1-02: Generator 缺少自检查报告和预验收报告的强制输出

**文档要求** (6.3-输出产物): "代码开发自检查报告 `self_check_report_xx.md` + 预验收报告（存放于目标程序 `docs/sprint/` 目录）"
**文档要求** (四-DEV): "输出自检查报告+预验收报告，写入目标程序目录"

**实际情况** (`src/agents/generator.ts`):
- `GeneratorAgent` 只有一个 `develop()` 和 `fix()` 方法，调用 `this.run()` 执行 LLM
- 没有任何代码强制要求 Generator 输出 `self_check_report_xx.md`
- 没有任何代码强制要求 Generator 输出预验收报告
- Generator 的 system prompt 中提到"完成自检查"，但这只是文本指导，没有程序化验证
- `docs/sprint/` 目录下不会自动生成自检查报告

**涉及文件**: `src/agents/generator.ts`, `prompts/generator_system.md`

---

### P1-03: Evaluator 验收未强制要求实际运行测试

**文档要求** (6.4-System Prompt 第4条): "你必须通过工具集在目标程序沙箱内实际运行代码、执行测试用例、安全扫描，验证功能可用性与安全性，绝对不允许只静态审查代码就给出验收结论"

**实际情况** (`src/agents/evaluator.ts`):
- `EvaluatorAgent.evaluate()` 仅调用 `this.run()` 将 prompt 传给 LLM
- 没有程序化逻辑强制要求 Evaluator 执行 bash 工具运行测试
- 没有检测验收报告中是否包含实际测试执行结果
- 完全依赖 LLM 是否选择使用 bash/grep/security-scan 工具

**影响**: Evaluator 可能仅通过 file_read 做静态代码审查就给出验收结论，违反框架铁则。

**涉及文件**: `src/agents/evaluator.ts`, `src/orchestrator/harness.ts:706-718`

---

### P1-04: Sprint 合同协商失败后未按文档触发 Planner 仲裁

**文档要求** (四-SPRINT_NEGOTIATION): "3轮协商未达成一致，触发Planner介入仲裁；仲裁后仍无法执行，进入人工介入状态"

**实际情况** (`src/orchestrator/negotiation.ts:99-111`):
```typescript
// Max rounds reached without agreement — 直接返回失败
return {
  success: false,
  contractPath,
  rounds: this.maxRounds,
  issues,
};
```

协商失败后直接返回 `success: false`，没有触发 Planner 仲裁。在 `harness.ts:641-644` 中：
```typescript
if (!negotiationResult.success) {
  this.projectLogger.error('Sprint contract negotiation failed, aborting sprint');
  this.metrics.endPhase(`SPRINT_${sprintId}`);
  return; // 直接返回 undefined，不是 'failed'
}
```

注意这里 `return` 没有 `as const`，返回值是 `undefined` 而非 `'failed'`，调用方 (`harness.ts:586`) 的 `sprintResult === 'failed'` 判断将不匹配，导致 Sprint 循环静默继续下一个 Sprint。

**影响**: 协商失败的 Sprint 被静默跳过而非触发仲裁/回退/人工介入。

**涉及文件**: `src/orchestrator/negotiation.ts:99-111`, `src/orchestrator/harness.ts:641-644`

---

### P1-05: 双仓隔离校验未在每个关键节点执行

**文档要求** (铁则10): "全流程实时监控元程序/目标程序隔离状态，发现跨仓违规操作立即暂停流程"
**文档要求** (7.4-6): "全流程每个关键节点必须执行双仓隔离校验"

**实际情况**: 隔离校验仅在以下位置执行：
- META_INIT 阶段 (`harness.ts:157-160`)
- PROJECT_INIT 结束时 (`harness.ts:397`)
- RELEASE 结束时 (`harness.ts:905`)

缺少隔离校验的关键节点：
- PLANNING 结束时
- 每个 Sprint 合并后
- FINAL_ACCEPTANCE 前
- 每次异常处理后恢复前

**涉及文件**: `src/orchestrator/harness.ts`

---

### P1-06: 人工介入缺少通知机制实现

**文档要求** (四-MANUAL_INTERVENTION): "立即暂停框架全流程运行；输出完整异常报告...等待人工处理"

**实际情况** (`src/orchestrator/manual-intervention.ts`):
- `requestIntervention()` 仅将信息写入 JSONL 文件和创建 Git 审计提交
- 没有任何通知机制（如邮件、Webhook、Slack、终端告警）
- 框架进入 `MANUAL_INTERVENTION` 状态后，`run()` 方法直接抛出异常退出
- 没有实现"等待人工处理"的轮询/监听机制 — 框架直接终止，不会等待恢复

**影响**: 人工介入后框架直接退出，无法通过人工指令恢复，违反文档要求。

**涉及文件**: `src/orchestrator/manual-intervention.ts`

---

### P1-07: 配置文件未实现加密存储

**文档要求** (二-2.2): "元程序配置（`harness_config.json`...敏感信息加密存储）"
**文档要求** (四-META_INIT): "读取加密元程序配置文件"

**实际情况**:
- `harness_config.json` 以明文 JSON 存储
- `src/config.ts` 读取 API key 时要求来自环境变量（这是正确的），但配置文件本身无加密
- 没有 `harness_config.json` 的加密/解密逻辑
- 框架文档要求"敏感信息加密存储"，代码未实现

**涉及文件**: `src/config.ts`, `harness_config.json`

---

### P1-08: 日志未严格采用 JSON 结构化格式

**文档要求** (铁则15): "日志统一采用 JSON 结构化格式"
**文档要求** (二-2.2): "元程序运行日志与目标程序构建日志...JSON结构化"

**实际情况** (`src/logger/index.ts`):
- 日志以 JSONL（JSON Lines）格式写入，每行一个 JSON 对象 — 这符合要求
- 但 `harness.ts` 中的 `log()` 方法 (`harness.ts:1155-1158`) 直接使用 `console.log(chalk.blue(...))` 输出非结构化文本到终端
- 终端输出与 JSON 结构化日志是两个独立系统，但 `log()` 的重要信息（如 "Sprint 验收通过"）不经过 logger，仅输出到终端
- 这导致部分关键运行时信息未写入结构化日志

**涉及文件**: `src/orchestrator/harness.ts:1155-1158`, `src/logger/index.ts`

---

## 四、一般级问题 (P2)

### P2-01: ParserAgent 固定输入源未严格限定

**文档要求** (6.2-固定输入源): "仅能传入以下文件，严禁额外传入"

**实际情况** (`src/agents/planner.ts`): `plan()` 方法接受一个 `standardReq` 字符串参数，调用方可传入任何内容。在架构反馈修订时 (`harness.ts:747-751`)，传入了拼接的反馈报告文本，这不属于文档规定的固定输入源。

### P2-02: Evaluator 验收评分解析依赖正则表达式，脆弱且不严谨

**实际情况** (`src/orchestrator/harness.ts:1056-1086`):
`checkEvaluationPassed()` 使用正则匹配 Markdown 表格中的评分：
```typescript
const dimScorePattern = /\|\s*(功能完整性|代码质量与架构合规性|可运行性与稳定性|可测试性与文档完整性|代码安全性)\s*\|\s*(\d+%?)\s*\|\s*(\d+\.?\d*)\s*\|\s*(\d+)\s*\|/g;
```
- 表格列的微小变化（如空格、换行、列顺序调整）会导致解析失败
- 解析失败时默认为"不通过"（这是安全的），但也意味着合法通过的验收可能被误判

### P2-03: Sprint ID 解析逻辑过于简单

**实际情况** (`src/orchestrator/harness.ts:1025-1031`):
```typescript
private parseSprintIds(sprintPlan: string): string[] {
  const matches = sprintPlan.match(/sprint-\d+/gi);
  return [...new Set(matches.map(m => m.toLowerCase()))];
}
```
全局匹配 `sprint-\d+` 可能误匹配文档中的示例文本、注释、说明段落中的引用。应限定匹配范围为 Sprint 计划的结构化章节。

### P2-04: Token 统计不精确

**实际情况** (`src/orchestrator/harness.ts`):
- `metrics.recordAgentCall('planner', ...)` 只记录了调用耗时，未记录该次调用消耗的 token
- `LLMClient` 累计了全局 token，但没有按 Agent 维度拆分
- `MetricsCollector.recordTokens()` 方法存在但从未被调用
- 最终报告中的 Token 分 Agent 统计永远为空

### P2-05: PreEvaluator 不验证预验收报告的存在

**文档要求** (四-PRE_EVALUATION): "预验收校验" 应包含对 Generator 自检报告的验证

**实际情况** (`src/orchestrator/pre-evaluation.ts`): PreEvaluator 不检查 `self_check_report_xx.md` 是否存在，也不检查 Generator 的预验收报告。

### P2-06: 合并冲突处理不完善

**实际情况** (`src/git/manager.ts:73-78`):
```typescript
async mergeBranch(branch, targetBranch = 'dev'): Promise<boolean> {
  await this.exec(['git', 'checkout', targetBranch]);
  const result = await this.exec(['git', 'merge', '--no-edit', branch], false);
  return !result.failed;
}
```
- 使用 `--no-edit` 但没有冲突自动解决策略
- 合并失败后没有清理残留的合并状态
- 文档要求"自动解决合并冲突，无法自动解决的触发 Planner 介入"，代码中没有实现

### P2-07: `executeSprint` 返回值不一致

**实际情况** (`src/orchestrator/harness.ts:641-644, 817`):
- 协商失败时 `return;` 返回 `undefined`
- Sprint 失败时 `return 'failed' as const;`
- Sprint 通过时 `return 'passed' as const;`
- 调用方 (`harness.ts:586`) 只检查 `'passed'` 和 `'failed'`，`undefined` 被忽略

### P2-08: 异常处理器缺少 `consecutiveFailures` 重置时机

**实际情况** (`src/exception/handler.ts`):
- `resetConsecutiveFailures()` 仅在验收通过时被调用 (`harness.ts:765`)
- 但跨 Sprint 的连续失败不会重置 — 如果 Sprint-1 失败3次，Sprint-2 的第一次失败就可能触发升级

### P2-09: `lockMetaDirectory` 跳过 `.git` 和 `node_modules` 目录

**实际情况** (`src/isolation/monitor.ts:247`):
```typescript
if (entry.name === 'node_modules' || entry.name === '.git') continue;
```
跳过 `.git` 意味着元程序的 Git 配置文件在构建期仍然可写。虽然 Git 操作通过 `validateGitOperation` 额外保护，但直接的文件系统写入（如 `echo malicious > .git/config`）不会被阻止。

### P2-10: 检查点管理器不保存项目状态

**实际情况** (`src/orchestrator/checkpoint.ts`):
检查点只保存了 `currentSprintId` 和 `completedSprints`，但恢复时没有将 `StateMachine` 的状态恢复到检查点时的值。`harness.ts:145-149` 只使用检查点状态决定跳过哪些阶段，不恢复状态机。

### P2-11: 最终验收报告缺少安全扫描强制要求

**实际情况** (`src/orchestrator/harness.ts:866-887`):
最终验收使用一个临时创建的 EvaluatorAgent 实例，但传入的 prompt 只要求"检查所有核心功能是否完整实现"，没有明确要求执行安全扫描。

### P2-12: `project_structure.md` 和 `code_standard.md` 没有独立验证

**实际情况** (`src/artifacts/validator.ts:84-107`):
`validatePlanningDocs()` 对所有5个文件调用 `validateFile()`，但 `project_structure.md` 和 `code_standard.md` 没有对应的 Zod Schema，会落入 `default` 分支跳过验证。

---

## 五、提示级问题 (P3)

### P3-01: Prompt 模板与文档定义存在差异

`prompts/planner_system.md` 的内容比文档第六章 Planner 强制 System Prompt 简化了很多，缺少以下文档要求的规则：
- 第4条 "你必须明确需求边界，清晰定义「做什么」与「不做什么」"
- 第7条 "你必须接收并响应Evaluator的架构反向反馈"

### P3-02: Sprint 合同 Schema 缺少安全编码要求字段

文档要求 Sprint 合同必须包含"安全编码要求"章节，但 `SprintContractSchema` 中没有 `securityRequirements` 字段。

### P3-03: `harness_config.json` 路径配置使用相对路径

```json
{
  "paths": {
    "workspace": "./workspace",
    "ideaFile": "./workspace/idea.md",
    "targetProject": "./workspace/target_project",
    "metaLogs": "./meta_logs"
  }
}
```
虽然 `config.ts` 会将其解析为绝对路径，但嵌套场景下（文档方案二）的路径解析可能不正确。

### P3-04: `StandardRequirementSchema` 缺少必填的约束条件字段

文档要求标准化需求包含"约束条件"和"不做范围"，但 Schema 中 `constraints` 和 `outOfScope` 是 `.optional()`，不是必填。

### P3-05: 回滚管理器没有实现"批量 revert 提交整理"

**文档要求** (5.3.4): "批量回退自动执行提交整理"

**实际情况**: 回滚管理器对每个 commit 执行单独的 `git revert --no-commit` + `git commit`，虽然保持了可追溯性（这是好的），但没有实现"提交整理"（如将多个 revert 合并为一个整理后的提交）。

### P3-06: 缺少 FINISHED 状态的归档实现

**文档要求** (四-FINISHED): "归档元程序与目标程序的全流程日志、报告、结构化产物"

**实际情况** (`src/orchestrator/harness.ts:892-926`): RELEASE 阶段直接转换到 FINISHED，但 FINISHED 状态没有对应的归档执行逻辑（日志归档、产物整理等）。

### P3-07: `docs` 目录未被创建

`src/git/manager.ts:48` 创建目录结构时创建了 `docs/plan`, `docs/sprint`, `docs/report`，但框架文档中 `docs/` 根目录也需要存在（用于存放 README 等交付文档）。

---

## 六、架构对齐度检查

### 6.1 四层架构实现对照

| 文档要求模块 | 实现状态 | 对应文件 | 差距说明 |
|-------------|---------|---------|---------|
| **接入层-需求解析模块** | 部分 | `harness.ts:406-452` | 缺少完整性校验和补全机制 |
| **接入层-双环境初始化模块** | 基本完成 | `harness.ts:152-170, 373-402` | 缺少权限隔离校验报告 |
| **核心编排层-Harness主编排器** | 完成 | `harness.ts` | 核心流程完整 |
| **核心编排层-双状态管理模块** | 完成 | `state/machine.ts` | 快照恢复不完整 |
| **多智能体层-Planner** | 完成 | `agents/planner.ts` | 输入源控制不严格 |
| **多智能体层-Generator** | 完成 | `agents/generator.ts` | 缺少自检报告强制输出 |
| **多智能体层-Evaluator** | 完成 | `agents/evaluator.ts` | 缺少工具实际运行的程序化验证 |
| **基础能力层-双仓Git管控** | 完成 | `git/manager.ts`, `isolation/monitor.ts` | 校验点覆盖不全 |
| **基础能力层-工具集模块** | 完成 | `tools/*.ts` | 最小权限沙箱基本到位 |
| **基础能力层-双日志模块** | 完成 | `logger/index.ts` | 部分关键日志走 console.log |
| **基础能力层-配置中心模块** | 部分 | `config.ts` | 缺少加密存储 |

### 6.2 FSM 16个状态实现对照

| 状态 | 枚举定义 | 流转实现 | 隔离校验 | 完整度 |
|------|---------|---------|---------|--------|
| META_INIT | Yes | Yes | Yes | 完整 |
| PROJECT_INIT | Yes | Yes | Yes | 完整 |
| REQUIREMENT_PARSE | Yes | 部分 | No | 缺校验 |
| PLANNING | Yes | Yes | No | 缺校验 |
| SPRINT_DISPATCH | Yes | Yes | No | 缺校验 |
| SPRINT_NEGOTIATION | Yes | Yes | No | 缺校验 |
| DEV | Yes | Yes | No | 缺校验 |
| PRE_EVALUATION | Yes | Yes | No | 缺校验 |
| EVALUATION | Yes | Yes | No | 缺校验 |
| SPRINT_MERGE | Yes | Yes | No | 缺校验 |
| FINAL_ACCEPTANCE | Yes | Yes | No | 缺校验 |
| RELEASE | Yes | Yes | Yes | 基本完整 |
| FINISHED | Yes | 部分 | No | 缺归档 |
| EXCEPTION_HANDLE | Yes | Yes | No | 缺恢复校验 |
| MANUAL_INTERVENTION | Yes | 部分 | No | 缺通知/等待 |

---

## 七、修复优先级建议

### 第一优先级（阻断级，必须立即修复）

1. **P0-02**: 重写 `ArtifactValidator.extractStructuredData()` — 实现真正的 Markdown → 结构化数据提取，确保 Zod Schema 验证能真正发挥作用
2. **P0-04**: 为每个 Agent 创建独立的 `LLMClient` 和 `ToolRegistry` 实例
3. **P0-05**: 重写 `shouldSkipPhase()` — 基于 `completedSprints` 列表精确恢复到中断的 Sprint
4. **P0-03**: 实现需求完整性校验和迭代补全机制
5. **P0-01**: 至少为隔离监控、状态机、回滚管理器、异常处理器添加核心单元测试

### 第二优先级（严重级，尽快修复）

6. **P1-04**: 实现协商失败后的 Planner 仲裁机制，并修复 `return` 值不一致问题
7. **P1-02**: 强制 Generator 输出自检查报告，并在 PreEvaluator 中验证
8. **P1-03**: 在 Evaluator 验收后程序化检查是否实际执行了测试/安全扫描
9. **P1-05**: 在每个关键状态流转节点添加隔离校验
10. **P1-06**: 实现人工介入的通知机制和等待恢复机制

### 第三优先级（一般级，迭代修复）

11. 按 P2 编号逐一修复

---

**审计结论**: 框架的架构设计基本完整，核心流程可运行，但在产物验证、状态恢复、隔离校验覆盖率、Agent 独立性、测试覆盖等关键维度存在显著不足。建议在投入实际项目构建前，优先修复所有阻断级和严重级问题。

---

*报告生成时间: 2026-04-06*
*审计工具: 人工逐行代码审查 vs framework.md v3.1*
