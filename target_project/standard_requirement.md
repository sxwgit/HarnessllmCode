# 需求文档：CodeAgent CLI

## 1. 项目名称与概述

**项目名称**: CodeAgent

**项目类型**: 类 Claude Code 的命令行 AI 编程助手

**项目概述**: 
一个运行在终端的 AI Agent 系统，通过大模型流式交互、工具调用循环（Tool-Use Loop）和权限控制机制，实现自动化代码开发、搜索、编辑等任务。系统以"工具即一等公民"为设计理念，通过注册机制管理各类工具，支持子 Agent 嵌套执行。

---

## 2. 核心功能清单

| 功能ID | 模块 | 功能描述 | 优先级 |
|--------|------|----------|--------|
| **F001** | 大模型交互 | Anthropic API 兼容的 MiniMax 流式调用 + Tool-Use Loop 执行引擎 | P0 |
| **F002** | 工具系统 | Tool 接口类型定义 + 全局工具注册表管理 | P0 |
| **F003** | 核心工具-Bash | BashTool: 执行 shell 命令，权限控制 | P0 |
| **F004** | 核心工具-文件读取 | FileReadTool: 按路径读取文件内容 | P0 |
| **F005** | 核心工具-文件写入 | FileWriteTool: 创建/覆盖文件，支持目录创建 | P0 |
| **F006** | 核心工具-文件编辑 | FileEditTool: 基于 diff 的局部编辑 | P0 |
| **F007** | 搜索工具-Grep | GrepTool: 正则搜索文件内容 | P0 |
| **F008** | 搜索工具-Glob | GlobTool: 按模式匹配文件路径 | P0 |
| **F009** | CLI 入口 | 命令行参数解析 (init, chat, --help 等) | P0 |
| **F010** | 权限系统 | 用户确认机制 (Yes/No/Always/Later) + 危险命令识别 | P0 |
| **F011** | 上下文管理 | System Prompt 构建 + 消息规范化 (Human/Assistant/Tool Result) | P0 |
| **F012** | 子 Agent | AgentTool: 启动子进程执行独立对话循环，支持嵌套 | P1 |
| **F013** | 上下文压缩 | CompactTool: 长对话历史压缩摘要 | P1 |
| **F014** | REPL UI | 终端交互界面：消息渲染 + 输入框 + 流式输出 | P1 |
| **F015** | 认证模块 | API Key 验证 (环境变量 MINIMAX_API_KEY) | P1 |
| **F016** | Token 估算 | 输入/输出 token 计数与成本估算 | P1 |
| **F017** | AskUserQuestion | 用户交互工具：多选项/确认/文本输入 | P1 |
| **F018** | Slash 命令 | /commit, /review, /compact 等快捷命令 | P2 |
| **F019** | 会话恢复 | Resume 会话：从中断点恢复对话状态 | P2 |
| **F020** | CLAUDE.md | 项目级配置加载与解析 | P2 |
| **F021** | MCP 集成 | 外部工具服务器协议支持 | P2 |
| **F022** | OAuth 认证 | 完整第三方认证流程 | P2 |
| **F023** | WebFetch | HTTP 请求工具 | P2 |
| **F024** | WebSearch | 搜索引擎集成 | P2 |

---

## 3. 技术栈要求

| 类别 | 要求 |
|------|------|
| **运行时** | Node.js (>=18) |
| **类型校验** | Zod (Schema 定义与验证) |
| **API 兼容** | MiniMax Text API (Anthropic-compatible) |
| **模型** | MiniMax-M2.7-highspeed |
| **运行环境** | macOS |
| **API Key 配置** | 环境变量 `MINIMAX_API_KEY`，不写入代码仓库 |

### 架构原则

1. **Tool 是一等公民**: 每个工具自包含（Schema + 权限 + 执行逻辑），通过注册表统一管理
2. **Feature Flag 驱动**: 使用编译时特性开关实现功能渐进式发布
3. **流式优先**: API 调用到 UI 渲染全部流式处理
4. **子 Agent 工具化**: AgentTool 作为普通工具，通过子进程执行独立对话

---

## 4. 约束条件

| 约束项 | 说明 |
|--------|------|
| **环境限制** | 仅支持 macOS 环境 |
| **API Key 安全** | 不得将 `MINIMAX_API_KEY` 写入任何源码或配置文件 |
| **依赖管理** | 使用 npm/node_modules，不引入 Python 生态 |
| **最小可用版本** | P0 功能必须完整可用，不可部分实现 |

---

## 5. 不做范围

| 模块 | 说明 |
|------|------|
| **Windows/Linux 支持** | 当前版本仅支持 macOS |
| **本地模型** | 不支持 Ollama 或本地 LLM |
| **GUI 界面** | 仅 CLI 终端界面，无桌面/Web UI |
| **实时协作** | 不支持多用户同时编辑 |
| **代码解释器** | 不实现代码执行沙箱（安全隔离） |
| **移动端** | 无移动端适配计划 |