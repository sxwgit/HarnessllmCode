# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

本仓库是一个 **双结构项目**，实现了自主多智能体代码开发 Harness 框架。两个独立程序严格隔离：

- **`harness_meta/`** — 元程序（Harness 框架），通过三个 AI 智能体（Planner、Generator、Evaluator）以 GAN 式对抗闭环自主完成软件开发。
- **`target_project/`** — 目标程序（MiniOpenCode），由 Harness 框架自主构建的轻量级 CLI AI 编码助手。
- **`docs/`** — 框架规范 (`framework.md` v3.1) 和产品创意 (`idea.md`)。

## 核心开发铁则（必读）

**target_project 的所有代码必须由 harness_meta 框架自主生成，严禁 Claude Code 直接编写目标程序代码。**

### 为什么这条规则不可突破

harness_meta 框架的设计核心价值是 **GAN 式对抗闭环**：

```
正确流程：
  harness 编排器 → Planner(规划) → Generator(生成) → Evaluator(评审) → 验收
                                                                  ↑
                                                          一票否决，打回修复

错误流程（已被证实失败）：
  Claude Code → 直接写代码 → 用户手动测试发现 bug → 手动修
```

**过往教训**：Claude Code 曾直接编写 target_project 的 Sprint-01 到 Sprint-05 代码（CLI、LLM 客户端、工具系统、Agent 循环、Session 持久化），跳过了：
- Sprint 合同协商（Generator 与 Evaluator 谈判）
- 预验收校验（Generator 自检）
- 正式验收（Evaluator 独立评审，硬阈值一票否决）
- 完整 Git 追溯

结果：用户测试时立即暴露 Zod 验证 bug（空 content 数组导致运行时崩溃）——这个 bug 在 Evaluator 独立评审环节本应被捕获。**对抗闭环的意义正在于此**。

### Claude Code 的职责边界

| 允许 | 禁止 |
|------|------|
| 修复/改进 `harness_meta/` 框架代码 | 直接编写 `target_project/` 的业务代码 |
| 帮助调试 harness 的运行问题 | 绕过 harness 直接实现功能 |
| 更新 `docs/` 中的需求/规范文档 | 代替 Generator/Evaluator 做验收 |
| 帮助启动和监控 harness 执行 | 修改 harness 的状态机流程 |

### 正确的开发工作流

```
1. 确认需求在 docs/idea.md 中
2. 启动 harness: cd harness_meta && npm start
3. harness 自动完成: 需求解析 → 规划 → Sprint 协商 → 代码生成 → 验收 → 交付
4. 人工仅在框架约定的极端异常场景介入
5. 所有决策、代码变更、评审结果必须通过 Git 可追溯
```

## 命令

### Harness 元程序 (`harness_meta/`)

```bash
cd harness_meta
npm install
npm start              # 运行 harness（需要 MINIMAX_API_KEY 环境变量）
npm run dev            # Watch 模式开发
npm test               # 运行所有测试 (vitest)
npm run test:watch     # Watch 模式测试
```

### 运行监控（推荐）

启动 harness 后，在另一个终端运行监控脚本，自动定期检查进度：

```bash
cd harness_meta
./scripts/monitor.sh           # 默认每 30 秒检查一次
./scripts/monitor.sh 60        # 自定义间隔（60 秒）
```

监控内容：
- Harness 进程是否存活
- 当前状态机阶段和 Sprint 进度
- 已完成的检查点列表
- 已生成的设计文档和代码文件数
- 最新一条日志（级别、时间、内容）

### 重置 harness 状态（从头开始）

当需要清除旧状态重新运行时：

```bash
rm -rf harness_meta/checkpoints harness_meta/meta_state.json target_project
cd harness_meta && npm start
```

### 目标程序（由 harness 管理，非人工操作）

```bash
cd target_project
npm install            # 安装依赖
npm run build          # TypeScript 编译
npm test               # 运行测试
npm run typecheck      # 类型检查
```

单个测试文件：`npx vitest run test/path/to/test.ts`

## 架构

### 双隔离架构（关键）

元程序和目标程序 **物理和逻辑隔离**：
- 独立目录，独立 Git 仓库
- 构建期元程序目录只读
- 禁止跨仓库 Git 操作
- 独立状态文件和 JSON 结构化日志目录
- 智能体和工具只能在目标程序目录内操作

### Harness 框架 (`harness_meta/src/`)

**一核三体四层架构：**
- **编排器** (`orchestrator/`) — 中央大脑，管理状态机转换、智能体调度和整体开发生命周期
- **智能体** (`agents/`) — 三个核心智能体：Planner、Generator、Evaluator，每次调用为干净会话
- **工具** (`tools/`) — BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, SecurityScanTool，沙箱最小权限
- **支撑模块**：`llm/`（LLM 客户端）、`dual_git_manager/`（双仓 Git 管控）、`isolation/`（实时隔离监控）、`exception/`（分级自愈+回退）、`state/`（断点状态管理）、`artifacts/`（结构化产物验证）

### 状态机流程

`META_INIT → PROJECT_INIT → REQUIREMENT_PARSE → PLANNING → SPRINT_DISPATCH → SPRINT_NEGOTIATION → DEV → PRE_EVALUATION → EVALUATION → SPRINT_MERGE → FINAL_ACCEPTANCE → RELEASE → FINISHED`

关键规则：Sprint 合同必须 100% 达成一致才能开始开发。验收采用硬阈值（平均分 ≥ 7，每个维度 ≥ 6，一票否决制）。

### 目标程序 (`target_project/`)

MiniOpenCode CLI — 受 Claude Code 启发的轻量级编码助手，使用 Node.js + Zod。由 harness 框架自主构建。

## 关键配置

- **`harness_meta/harness_config.json`** — LLM 设置（MiniMax M2.7-highspeed via Anthropic 兼容 API）、阈值、路径。API 密钥来自 `MINIMAX_API_KEY` 环境变量。
- **`harness_meta/prompts/`** — Planner、Generator、Evaluator 智能体的系统提示词。

## 技术栈

两个项目：**TypeScript, ESM modules, Zod 验证, Vitest 测试**。Harness 额外使用 `execa`（进程执行）、`fast-glob`（文件匹配）、`chalk`（终端输出）。

## 测试

Harness 测试在 `harness_meta/test/` 中按里程碑编号（m01 至 m14），覆盖：初始化、需求解析、规划、Git 操作、智能体、Sprint 执行、异常处理、指标、断点续跑、交付验收、后置条件验证、结构化交接。
