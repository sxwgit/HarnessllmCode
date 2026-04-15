# 项目结构文档 (Project Structure)

## 1. 完整项目目录树

```
codeagent/
├── bin/
│   └── codeagent.js          # CLI 入口脚本
├── src/
│   ├── cli/
│   │   ├── index.ts          # CLI 主入口
│   │   ├── init.ts           # init 命令实现
│   │   ├── chat.ts           # chat 命令实现
│   │   └── help.ts           # help 命令实现
│   ├── ui/
│   │   ├── ReplUI.ts         # REPL 主类
│   │   ├── MessageRenderer.ts # 消息渲染器
│   │   ├── InputHandler.ts   # 输入处理
│   │   └── components/       # UI 组件
│   │       ├── StatusBar.ts
│   │       └── Progress.ts
│   ├── agent/
│   │   ├── AgentEngine.ts    # Agent 引擎主类
│   │   ├── ToolUseLoop.ts    # Tool-Use Loop
│   │   ├── Session.ts        # 会话管理
│   │   └── types.ts          # Agent 类型定义
│   ├── context/
│   │   ├── ContextManager.ts # 上下文管理器
│   │   ├── SystemPrompt.ts   # System Prompt 构建
│   │   └── MessageNormalizer.ts # 消息规范化
│   ├── tools/
│   │   ├── index.ts          # 工具系统导出
│   │   ├── ToolRegistry.ts   # 工具注册表
│   │   ├── ToolBase.ts       # 工具基类
│   │   ├── base/
│   │   │   └── Tool.ts       # Tool 接口定义
│   │   ├── bash/
│   │   │   ├── BashTool.ts   # Bash 工具
│   │   │   └── PermissionFilter.ts # 权限过滤器
│   │   ├── file/
│   │   │   ├── FileReadTool.ts
│   │   │   ├── FileWriteTool.ts
│   │   │   └── FileEditTool.ts
│   │   ├── search/
│   │   │   ├── GrepTool.ts
│   │   │   └── GlobTool.ts
│   │   ├── agent/
│   │   │   └── AgentTool.ts  # 子 Agent 工具
│   │   ├── compact/
│   │   │   └── CompactTool.ts # 上下文压缩工具
│   │   ├── ask/
│   │   │   └── AskUserTool.ts # 用户交互工具
│   │   └── web/
│   │       ├── WebFetchTool.ts
│   │       └── WebSearchTool.ts
│   ├── api/
│   │   ├── index.ts          # API 模块导出
│   │   ├── MiniMaxAdapter.ts # MiniMax API 适配器
│   │   ├── StreamingClient.ts # 流式客户端
│   │   └── types.ts          # API 类型定义
│   ├── auth/
│   │   ├── AuthModule.ts     # 认证模块
│   │   ├── ApiKeyValidator.ts # API Key 验证
│   │   └── TokenManager.ts   # Token 管理
│   ├── config/
│   │   ├── ConfigManager.ts  # 配置管理器
│   │   ├── EnvLoader.ts      # 环境变量加载
│   │   └── schema.ts         # 配置 Schema
│   ├── utils/
│   │   ├── logger.ts         # 日志工具
│   │   ├── async.ts          # 异步工具
│   │   └── tokenizer.ts      # Token 估算
│   └── types/
│       └── index.ts          # 全局类型定义
├── tests/
│   ├── unit/                 # 单元测试
│   │   ├── tools/
│   │   ├── agent/
│   │   └── api/
│   └── integration/           # 集成测试
├── docs/
│   ├── plan/                 # 规划文档
│   └── guides/               # 使用指南
├── scripts/
│   └── build.sh              # 构建脚本
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── .gitignore
├── .env.example
└── README.md
```

---

## 2. 目录用途说明

### 2.1 核心目录

| 目录 | 用途 | 重要性 |
|------|------|--------|
| `src/cli/` | 命令行入口模块，处理用户命令行输入 | 核心 |
| `src/agent/` | Agent 引擎核心，实现 Tool-Use Loop | 核心 |
| `src/tools/` | 所有工具实现，系统核心能力 | 核心 |
| `src/api/` | 外部 API 适配层 | 核心 |
| `src/ui/` | 终端用户界面 | 重要 |
| `src/context/` | 对话上下文管理 | 重要 |
| `src/auth/` | 认证和授权 | 重要 |

### 2.2 支撑目录

| 目录 | 用途 | 重要性 |
|------|------|--------|
| `src/config/` | 配置管理 | 支撑 |
| `src/utils/` | 工具函数库 | 支撑 |
| `src/types/` | 全局类型定义 | 支撑 |
| `tests/` | 测试代码 | 质量 |
| `docs/` | 文档 | 文档 |
| `bin/` | CLI 可执行脚本 | 部署 |

---

## 3. 核心文件路径与职责

### 3.1 CLI 入口层

| 文件 | 职责 | 导出 |
|------|------|------|
| `bin/codeagent.js` | Node.js 入口脚本，shebang 执行 | - |
| `src/cli/index.ts` | CLI 主入口，命令路由 | `runCLI()` |
| `src/cli/init.ts` | 初始化项目配置 | `initCommand()` |
| `src/cli/chat.ts` | 启动聊天会话 | `chatCommand()` |
| `src/cli/help.ts` | 显示帮助信息 | `showHelp()` |

### 3.2 Agent 核心层

| 文件 | 职责 | 导出 |
|------|------|------|
| `src/agent/AgentEngine.ts` | Agent 引擎主类，协调各模块 | `AgentEngine` |
| `src/agent/ToolUseLoop.ts` | Tool-Use Loop 状态机实现 | `ToolUseLoop` |
| `src/agent/Session.ts` | 会话状态管理 | `Session` |

### 3.3 工具系统层

| 文件 | 职责 | 导出 |
|------|------|------|
| `src/tools/ToolRegistry.ts` | 全局工具注册表 | `ToolRegistry` |
| `src/tools/ToolBase.ts` | 工具基类 | `ToolBase` |
| `src/tools/base/Tool.ts` | Tool 接口定义 | `Tool` 接口 |
| `src/tools/bash/BashTool.ts` | Shell 命令执行工具 | `BashTool` |
| `src/tools/file/*.ts` | 文件操作工具集 | File*Tool |
| `src/tools/search/*.ts` | 搜索工具集 | GrepTool, GlobTool |

### 3.4 API 适配层

| 文件 | 职责 | 导出 |
|------|------|------|
| `src/api/MiniMaxAdapter.ts` | MiniMax API 适配器 | `MiniMaxAdapter` |
| `src/api/StreamingClient.ts` | 流式请求客户端 | `StreamingClient` |

### 3.5 UI 层

| 文件 | 职责 | 导出 |
|------|------|------|
| `src/ui/ReplUI.ts` | REPL 主界面类 | `ReplUI` |
| `src/ui/MessageRenderer.ts` | 消息渲染器 | `MessageRenderer` |

---

## 4. 配置文件管理规范

### 4.1 配置文件优先级

```
命令行参数 > 环境变量 > 项目配置 (.codeagent.yaml) > 默认配置
```

### 4.2 配置文件格式

```yaml
# .codeagent.yaml 示例
version: "1.0"
model: MiniMax-M2.7-highspeed
maxTokens: 4096
maxLoopCount: 100
timeout: 30000
tools:
  enabled:
    - bash
    - file
    - search
  disabled: []
fileOperation:
  allowedPaths:
    - "./"
  createDirs: true
dangerousCommands:
  - pattern: "rm -rf"
    riskLevel: high
    action: always_confirm
```

### 4.3 环境变量清单

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `MINIMAX_API_KEY` | 是 | - | MiniMax API 密钥 |
| `MINIMAX_BASE_URL` | 否 | https://api.minimax.chat | API 基础 URL |
| `CODEAGENT_CONFIG` | 否 | ./.codeagent.yaml | 配置文件路径 |
| `CODEAGENT_PROJECT_DIR` | 否 | process.cwd() | 项目目录 |

---

## 5. 构建与部署

### 5.1 构建流程

```bash
# 1. 安装依赖
npm install

# 2. TypeScript 编译
npm run build
# 输出: dist/ 目录

# 3. 生成 CLI 入口
node scripts/build.sh
# 输出: bin/codeagent
```

### 5.2 CLI 安装

```bash
# 全局安装
npm install -g

# 或使用 npx
npx codeagent chat
```

### 5.3 项目初始化

```bash
# 初始化新项目
codeagent init

# 启动聊天
codeagent chat

# 查看帮助
codeagent --help
```

---

## 6. 模块导入约定

### 6.1 导入规范

```typescript
// 从 src/ 开始的绝对导入
import { AgentEngine } from '@/agent/AgentEngine';
import { ToolRegistry } from '@/tools/ToolRegistry';

// 相对导入
import { BashTool } from '../tools/bash/BashTool';

// 类型导入
import type { Tool, ToolResult } from '@/tools/base/Tool';
```

### 6.2 路径别名配置 (tsconfig.json)

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

---

## 7. 测试文件结构

```
tests/
├── unit/
│   ├── tools/
│   │   ├── BashTool.test.ts
│   │   ├── FileReadTool.test.ts
│   │   ├── FileWriteTool.test.ts
│   │   ├── GrepTool.test.ts
│   │   └── GlobTool.test.ts
│   ├── agent/
│   │   ├── AgentEngine.test.ts
│   │   └── ToolUseLoop.test.ts
│   └── api/
│       └── MiniMaxAdapter.test.ts
└── integration/
    └── full-flow.test.ts
```

### 7.1 测试命名规范
- 单元测试: `[模块名].test.ts`
- 集成测试: `[功能名].integration.test.ts`
- 测试文件与源码同名，便于查找
