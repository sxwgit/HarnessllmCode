# 架构设计文档 (Architecture Design)

## 1. 整体架构

### 1.1 架构分层图

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Entry Layer                        │
│                    (commands/init.ts, chat.ts)                  │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        REPL UI Layer                            │
│                  (ui/ReplUI, MessageRenderer)                  │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Core Layer                           │
│        (AgentEngine, ToolUseLoop, ContextManager)               │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Tool System Layer                          │
│          (ToolRegistry, ToolBase, Individual Tools)             │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External API Layer                           │
│              (MiniMaxAdapter, AuthModule)                       │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 架构原则遵循
1. **Tool 是一等公民**: 工具系统独立运行，包含自身的 Schema、权限和执行逻辑
2. **分层清晰**: 每层职责单一，层间通过定义良好的接口通信
3. **依赖注入**: 核心组件通过依赖注入实现松耦合
4. **流式优先**: 从 API 到 UI 全链路流式处理

---

## 2. 核心模块职责划分

### 2.1 模块清单

| 模块 | 目录 | 职责 | 公开接口 |
|------|------|------|----------|
| CLI Entry | `src/cli/` | 命令行入口，参数解析 | `init`, `chat`, `help` 命令 |
| REPL UI | `src/ui/` | 终端交互界面渲染 | `ReplUI`, `MessageRenderer` |
| Agent Engine | `src/agent/` | AI 对话引擎，Tool-Use Loop | `AgentEngine`, `ToolUseLoop` |
| Context Manager | `src/context/` | 消息上下文管理 | `ContextManager` |
| Tool Registry | `src/tools/` | 工具注册与发现 | `ToolRegistry`, `registerTool` |
| Tool Base | `src/tools/base/` | 工具基类定义 | `Tool`, `ToolResult` |
| Bash Tool | `src/tools/bash/` | Shell 命令执行 | `BashTool` |
| File Tools | `src/tools/file/` | 文件读写编辑 | `FileReadTool`, `FileWriteTool`, `FileEditTool` |
| Search Tools | `src/tools/search/` | Grep/Glob 搜索 | `GrepTool`, `GlobTool` |
| API Adapter | `src/api/` | MiniMax API 适配 | `MiniMaxAdapter` |
| Auth Module | `src/auth/` | API Key 验证 | `AuthModule` |

### 2.2 模块边界

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CLI Entry  │────▶│   REPL UI    │────▶│ Agent Engine │
└──────────────┘     └──────────────┘     └──────────────┘
                                                │
                                                ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Auth       │◀────│  API Adapter │◀────│Tool Registry │
└──────────────┘     └──────────────┘     └──────────────┘
                                                 │
                              ┌──────────────────┼──────────────────┐
                              ▼                  ▼                  ▼
                       ┌──────────┐       ┌──────────┐       ┌──────────┐
                       │Bash Tool │       │File Tools│       │Search Tool│
                       └──────────┘       └──────────┘       └──────────┘
```

---

## 3. 数据模型

- Message: 聊天消息模型，包含字段 role(字符串), content(字符串数组), timestamp(数字)
- Session: 会话模型，包含字段 id(字符串), messages(Message数组), createdAt(数字)
- ToolCall: 工具调用模型，包含字段 name(字符串), arguments(对象), id(字符串)
- ToolResult: 工具执行结果模型，包含字段 toolCallId(字符串), output(字符串), error(字符串)
- ToolDefinition: 工具定义模型，包含字段 name(字符串), description(字符串), inputSchema(ZodSchema)
- PermissionRequest: 权限请求模型，包含字段 toolName(字符串), command(字符串), riskLevel(字符串)
- UserConfirmation: 用户确认模型，包含字段 action(字符串), choice(枚举: yes/no/always/later)

---

## 4. 接口规范

### 4.1 Tool 接口

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<ToolResult>;
}
```

### 4.2 Agent Engine 接口

```typescript
interface AgentEngine {
  run(userMessage: string): Promise<void>;
  stop(): void;
  getSession(): Session;
}
```

### 4.3 Tool Registry 接口

```typescript
interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
  clear(): void;
}
```

### 4.4 API Adapter 接口

```typescript
interface LLMAdapter {
  chat(messages: Message[], tools: ToolDefinition[]): AsyncIterable<string>;
  compact(messages: Message[]): Promise<Message>;
}
```

---

## 5. 技术栈选型与版本锁定

### 5.1 核心依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | >=18 | 运行时 |
| TypeScript | ^5.4 | 类型系统 |
| Zod | ^3.22 | Schema 验证 |
| minimax-node-sdk | ^1.0.0 | MiniMax API SDK |
| readline | 内置 | CLI 输入处理 |
| events | 内置 | 事件驱动 |

### 5.2 开发依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Vitest | ^1.4 | 单元测试 |
| ESLint | ^8.57 | 代码检查 |
| Prettier | ^3.2 | 代码格式化 |
| TypeScript | ^5.4 | 类型检查 |

### 5.3 配置文件

```json
{
  "name": "codeagent",
  "version": "0.1.0",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "zod": "^3.22.0",
    "minimax-node-sdk": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.4.0",
    "eslint": "^8.57.0",
    "prettier": "^3.2.0"
  }
}
```

---

## 6. Tool-Use Loop 执行流程

### 6.1 执行状态机

```
┌─────────┐    user input    ┌──────────────┐
│  IDLE   │─────────────────▶│ SENDING_MSG  │
└─────────┘                  └──────────────┘
     ▲                              │
     │                              ▼
     │                     ┌──────────────────┐
     │                     │  AWAITING_TOOL   │
     │                     └──────────────────┘
     │                              │
     │              ┌────────────────┼────────────────┐
     │              ▼                ▼                ▼
     │       ┌────────────┐  ┌────────────┐  ┌────────────┐
     │       │EXEC_TOOL_OK│  │EXEC_TOOL_ERR│  │NO_MORE_TOOL│
     │       └────────────┘  └────────────┘  └────────────┘
     │              │                │                │
     │              └───────┬────────┴────────────────┘
     │                      ▼
     │               ┌──────────────┐
     └───────────────│   RESPOND    │
                     └──────────────┘
```

### 6.2 循环终止条件
1. 模型返回最终响应（无 tool_use）
2. 达到最大循环次数（默认 100 次）
3. 用户主动中断
4. 执行出错

---

## 7. 异常处理架构

### 7.1 异常分类

| 异常类型 | 代码范围 | 处理策略 |
|----------|----------|----------|
| ValidationError | 1000-1999 | 记录日志，返回友好错误 |
| ToolExecutionError | 2000-2999 | 记录日志，继续循环 |
| APIError | 3000-3999 | 重试或终止 |
| AuthError | 4000-4999 | 提示用户检查配置 |
| PermissionError | 5000-5999 | 请求用户确认 |

### 7.2 异常处理原则
1. 所有异步操作必须 try-catch
2. 工具执行错误不中断 Tool-Use Loop
3. API 错误根据类型决定是否重试
4. 权限错误必须等待用户响应

---

## 8. 权限控制架构

### 8.1 危险命令识别规则

| 风险等级 | 规则 | 处理方式 |
|----------|------|----------|
| HIGH | rm -rf, mkfs, dd | 强制确认 |
| MEDIUM | chmod, chown, kill | 确认 |
| LOW | ls, cat, echo | 自动放行 |

### 8.2 用户选择持久化

```typescript
type PermissionChoice = 'yes' | 'no' | 'always' | 'later';

interface PermissionCache {
  [commandPattern: string]: PermissionChoice;
}
```

---

## 9. 子 Agent 架构

### 9.1 执行模型

```
┌─────────────────────────────────────────────────────┐
│                    Main Process                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────┐ │
│  │Main Agent   │───▶│ AgentTool   │───▶│Child    │ │
│  │Engine       │◀───│             │◀───│Process  │ │
│  └─────────────┘    └─────────────┘    └─────────┘ │
└─────────────────────────────────────────────────────┘
```

### 9.2 通信协议
- 使用进程间通信 (IPC)
- 父进程发送 task 描述
- 子进程返回执行结果
- 支持嵌套调用（子进程可再次调用 AgentTool）

---

## 10. 配置管理

### 10.1 环境变量

| 变量名 | 必需 | 说明 |
|--------|------|------|
| MINIMAX_API_KEY | 是 | MiniMax API 密钥 |
| MINIMAX_BASE_URL | 否 | API 基础 URL，默认官方 |
| CODEAGENT_CONFIG | 否 | 配置文件路径 |
| CODEAGENT_PROJECT_DIR | 否 | 项目目录，默认为 cwd |

### 10.2 配置文件 (可选)

```yaml
# .codeagent.yaml
model: MiniMax-M2.7-highspeed
maxTokens: 4096
maxLoopCount: 100
dangerousCommands:
  - pattern: "rm -rf"
    action: always_confirm
fileOperation:
  allowedPaths:
    - "./"
  createDirs: true
```
