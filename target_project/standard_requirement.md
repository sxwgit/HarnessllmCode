# 标准化需求文档

## 1. 项目名称与概述

**项目名称**: MiniCode (CLI Agent Tool)

**项目概述**:
一款类 Claude Code 的命令行 AI Agent 工具，基于 Node.js 开发，通过流式 API 与大模型交互，驱动工具系统完成代码开发任务。用户通过终端与 Agent 对话，Agent 可执行 Bash 命令、读写文件、搜索代码等操作。

**核心价值主张**: 开发者通过自然语言指令驱动 AI 完成编码任务，工具系统作为 Agent 的执行手脚。

---

## 2. 核心功能清单

### P0 优先级（核心骨架 - MVP）

| 功能 ID | 模块 | 功能描述 | 验收要点 |
|---------|------|----------|----------|
| P0-F01 | **大模型交互** | Anthropic API 兼容的流式调用 + Tool-Use Loop | 支持 `stream: true`，完整解析 `content` + `tool_use` + `tool_result` 循环 |
| P0-F02 | **工具系统** | Tool 类型定义 + 注册表机制 | 定义 `Tool` 接口，包含 name/schema/execute/permissions；注册表支持 add/get/list |
| P0-F03 | **BashTool** | 执行 shell 命令 | 支持 `cmd` 参数，执行后返回 stdout/stderr/exitCode |
| P0-F04 | **FileReadTool** | 读取文件内容 | 支持 `path` 参数，返回文件内容或错误 |
| P0-F05 | **FileWriteTool** | 写入文件内容 | 支持 `path` + `content` 参数，覆盖写入 |
| P0-F06 | **FileEditTool** | 编辑文件（局部修改） | 支持 `path` + `old_string` + `new_string` 参数 |
| P0-F07 | **GlobTool** | 文件路径模式匹配 | 支持 `pattern` 参数，返回匹配文件列表 |
| P0-F08 | **GrepTool** | 文本内容搜索 | 支持 `pattern` + `path` 参数，返回匹配行及位置 |
| P0-F09 | **CLI 入口** | 命令行参数解析和启动 | 支持 `minicode [task]` 形式启动，解析 `--no-stream` 等选项 |
| P0-F10 | **权限系统** | 危险操作的用户确认 | 执行 Bash/Write 等操作前 prompt 用户确认，支持 `yes/no/all` |
| P0-F11 | **上下文管理** | 系统提示词构建 + 消息规范化 | 构建包含可用工具列表的系统提示词，规范化消息格式 |

### P1 优先级（基础体验 - 日常可用）

| 功能 ID | 模块 | 功能描述 | 验收要点 |
|---------|------|----------|----------|
| P1-F01 | **AgentTool** | 子 Agent 并行执行 | 作为工具暴露，支持嵌套调用子进程执行独立对话 |
| P1-F02 | **上下文压缩** | Compact 消息压缩 | 合并历史消息为摘要，控制 token 总量 |
| P1-F03 | **REPL UI** | 终端交互界面 | 支持多行输入、命令历史（↑↓）、语法高亮 |
| P1-F04 | **认证系统** | API Key 管理 | 从环境变量或配置文件读取 MiniMax API Key |
| P1-F05 | **Token 估算** | Token 计数与成本控制 | 估算请求/响应 token 数，打印消耗统计 |
| P1-F06 | **AskUserQuestion** | 用户交互工具 | Agent 可主动向用户提问，获取额外信息 |

### P2 优先级（进阶能力 - 锦上添花）

| 功能 ID | 模块 | 功能描述 |
|---------|------|----------|
| P2-F01 | **Slash 命令** | `/commit`, `/review`, `/compact` 等快捷命令 |
| P2-F02 | **会话恢复** | Resume 断线会话，继续执行 |
| P2-F03 | **CLAUDE.md** | 项目级配置，支持自定义系统提示词 |
| P2-F04 | **MCP 集成** | 外部工具服务器协议支持 |
| P2-F05 | **OAuth** | 完整用户认证流程 |
| P2-F06 | **Web 工具** | WebFetch + WebSearch 网络访问 |

---

## 3. 技术栈要求

### 运行环境
- **OS**: macOS (当前开发环境)
- **Node.js**: >= 18.0.0
- **包管理器**: bun (优先) 或 npm

### 核心依赖

| 依赖 | 用途 | 版本要求 |
|------|------|----------|
| `zod` | Schema 校验与类型定义 | ^3.x |
| `minimaxi` 或原生 `fetch` | MiniMax API 调用 | - |
| `ink` (可选) | React 式终端 UI | ^4.x |
| `react` (可选) | UI 组件化 | ^18.x |

### API 配置

| 配置项 | 值 |
|--------|-----|
| **API Endpoint** | `https://api.minimaxi.com/v1/text/chatroom_v2` |
| **Model** | `MiniMax-M2.7-highspeed` |
| **认证方式** | Bearer Token (`{{MINIMAX_API_KEY}}`) |
| **协议** | Anthropic API 兼容 (stream: true) |

### 项目结构 (推荐)

```
minicode/
├── src/
│   ├── index.ts           # CLI 入口
│   ├── client.ts          # API 客户端
│   ├── agent.ts           # Agent 主循环 (Tool-Use Loop)
│   ├── tools/
│   │   ├── index.ts       # 工具注册表
│   │   ├── bash.ts        # BashTool
│   │   ├── file-read.ts   # FileReadTool
│   │   ├── file-write.ts  # FileWriteTool
│   │   ├── file-edit.ts   # FileEditTool
│   │   ├── glob.ts        # GlobTool
│   │   └── grep.ts        # GrepTool
│   ├── ui/
│   │   └── repl.ts        # REPL 交互界面
│   ├── types.ts           # Zod 类型定义
│   └── prompt.ts          # 系统提示词构建
├── package.json
└── tsconfig.json
```

---

## 4. 约束条件

### 功能性约束

| 约束项 | 说明 |
|--------|------|
| **流式优先** | 所有 API 调用和 UI 渲染必须流式，不得阻塞等待完整响应 |
| **安全底线** | 所有 Bash 执行、文件覆盖操作必须经用户确认 |
| **Anthropic 兼容** | 工具调用协议遵循 Anthropic Tool-Use 格式 |
| **零外部 daemon** | 不得依赖后台服务进程，纯单机运行 |

### 技术约束

| 约束项 | 说明 |
|--------|------|
| **Node.js 单 runtime** | 使用 `bun:x` 或原生 `Node.js` API，不混用 runtime |
| **TypeScript 强类型** | 核心模块全部使用 TypeScript，Zod 做运行时校验 |
| **Feature Flag** | 使用 `bun:bundle` 的 `feature()` 做编译时功能开关 |
| **无 native 依赖** | 避免需要编译的 native 模块，保证跨平台 |

### 环境约束

| 约束项 | 说明 |
|--------|------|
| **macOS 原生** | 使用 macOS 原生命令（`os.machine` 检测），不依赖 Linux 特定工具 |
| **API Key 安全** | 不得硬编码 Key，通过环境变量 `MINIMAX_API_KEY` 读取 |

---

## 5. 不做范围

以下功能明确不在本项目范围内：

| 范围外 | 说明 |
|--------|------|
| **GUI 客户端** | 无桌面应用或 Web UI，纯 CLI 工具 |
| **多用户/团队协作** | 无用户体系、无权限继承、无团队概念 |
| **代码审查/CI 集成** | 不对接 GitHub/GitLab，不做 PR 审查 |
| **持久化会话存储** | 无数据库，会话仅内存存在 |
| **插件市场** | 无插件机制，工具集固定 |
| **Windows/Linux 兼容** | 仅保证 macOS 可运行，其他平台不承诺 |
| **完整 Claude Code 兼容** | 参考架构思路，非 1:1 复刻 |

---

## 附录: MVP 最小功能集 (20% 工作量)

若需最快速度产出可用版本，仅实现以下 5 项：

```
[P0-F01] 流式 API 调用 + Tool-Use Loop
[P0-F03] BashTool
[P0-F04] FileReadTool
[P0-F09] 简单 CLI 入口
[P0-F10] 基础权限确认
```

**预期价值**: 可启动对话、执行命令、读写文件、安全可控。