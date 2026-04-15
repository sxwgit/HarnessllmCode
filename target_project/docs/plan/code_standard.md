# 代码规范文档 (Code Standard)

## 1. 命名规范

### 1.1 文件命名

| 类型 | 规范 | 示例 |
|------|------|------|
| TypeScript 源文件 | PascalCase.ts | `AgentEngine.ts`, `ToolRegistry.ts` |
| 测试文件 | `[模块名].test.ts` | `AgentEngine.test.ts` |
| 类型定义文件 | `[模块名].types.ts` | `agent.types.ts` |
| 工具函数文件 | camelCase.ts | `logger.ts`, `async.ts` |
| 配置文件 | kebab-case | `tsconfig.json`, `vitest.config.ts` |

### 1.2 变量与函数命名

| 类型 | 规范 | 示例 |
|------|------|------|
| 变量 | camelCase | `userMessage`, `apiKey` |
| 函数 | camelCase | `registerTool()`, `executeCommand()` |
| 类 | PascalCase | `class AgentEngine` |
| 接口 | PascalCase | `interface Tool` |
| 类型别名 | PascalCase | `type ToolResult` |
| 常量 | UPPER_SNAKE_CASE | `MAX_LOOP_COUNT`, `API_BASE_URL` |
| 枚举成员 | UPPER_SNAKE_CASE | `PermissionChoice.YES` |
| 私有属性 | _camelCase | `_session`, `_registry` |

### 1.3 目录命名

| 类型 | 规范 | 示例 |
|------|------|------|
| 功能模块目录 | kebab-case | `tool-registry.ts`, `api-adapter.ts` |
| 组件目录 | PascalCase | `components/`, `ui/` |

### 1.4 命名规则

```typescript
// ✅ 正确
const MAX_RETRY_COUNT = 3;
const userInput = "hello";
function executeTool() {}

// ❌ 错误
const max_retry_count = 3;
const UserInput = "hello";
function ExecuteTool() {}
```

---

## 2. 函数与类设计规范

### 2.1 函数设计

```typescript
// ✅ 正确：单一职责，参数类型明确
async function executeTool(tool: Tool, input: unknown): Promise<ToolResult> {
  // 实现
}

// ❌ 错误：职责过多，参数不明确
async function executeTool(tool, input, options, callback) {
  // 实现
}
```

### 2.2 类设计

```typescript
// ✅ 正确：职责清晰，依赖注入
class AgentEngine {
  constructor(
    private registry: ToolRegistry,
    private adapter: LLMAdapter,
    private ui: ReplUI
  ) {}

  async run(message: string): Promise<void> {
    // 实现
  }
}

// ❌ 错误：直接实例化依赖，违反依赖注入原则
class AgentEngine {
  constructor() {
    this.registry = new ToolRegistry();
    this.adapter = new MiniMaxAdapter();
  }
}
```

### 2.3 接口设计

```typescript
// ✅ 正确：接口职责单一
interface Tool {
  name: string;
  description: string;
  execute(input: unknown): Promise<ToolResult>;
}

interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
}

// ❌ 错误：接口职责过多
interface ToolSystem {
  register(): void;
  execute(): void;
  config(): void;
  // ... 过多职责
}
```

### 2.4 异步处理

```typescript
// ✅ 正确：async/await + try-catch
async function fetchData(): Promise<Result> {
  try {
    const response = await api.call();
    return response;
  } catch (error) {
    logger.error('Fetch failed', error);
    throw new APIError('Fetch failed', error);
  }
}

// ✅ 正确：Promise 链式调用
function fetchData(): Promise<Result> {
  return api.call()
    .then(response => processResponse(response))
    .catch(error => {
      logger.error('Fetch failed', error);
      throw error;
    });
}
```

---

## 3. 异常处理规范

### 3.1 异常类定义

```typescript
// 基础异常类
class CodeAgentError extends Error {
  constructor(
    message: string,
    public code: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'CodeAgentError';
  }
}

// 工具执行异常
class ToolExecutionError extends CodeAgentError {
  constructor(
    toolName: string,
    message: string,
    details?: unknown
  ) {
    super(message, 2000);
    this.name = 'ToolExecutionError';
  }
}

// API 异常
class APIError extends CodeAgentError {
  constructor(message: string, details?: unknown) {
    super(message, 3000, details);
    this.name = 'APIError';
  }
}

// 认证异常
class AuthError extends CodeAgentError {
  constructor(message: string) {
    super(message, 4000);
    this.name = 'AuthError';
  }
}

// 权限异常
class PermissionError extends CodeAgentError {
  constructor(message: string) {
    super(message, 5000);
    this.name = 'PermissionError';
  }
}
```

### 3.2 异常处理规则

| 场景 | 处理方式 |
|------|----------|
| 工具执行失败 | 记录日志，返回 ToolResult.error，继续循环 |
| API 调用失败 | 根据错误类型决定是否重试，重试不超过 3 次 |
| 参数校验失败 | 抛出 ValidationError，中断执行 |
| 权限不足 | 抛出 PermissionError，等待用户确认 |
| 未知错误 | 记录完整堆栈，返回友好错误信息 |

### 3.3 异常处理模板

```typescript
async function executeWithErrorHandling(): Promise<Result> {
  try {
    // 验证输入
    const validated = validateInput(input);
    
    // 执行逻辑
    const result = await performAction(validated);
    
    // 验证输出
    return validateOutput(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      // 参数错误，不重试
      throw error;
    }
    
    if (error instanceof APIError) {
      // API 错误，可重试
      if (canRetry(error)) {
        return retry();
      }
    }
    
    // 未知错误，记录并转换
    logger.error('Unexpected error', error);
    throw new CodeAgentError('Operation failed', 9999, error);
  }
}
```

---

## 4. 日志规范

### 4.1 日志级别

| 级别 | 使用场景 | 示例 |
|------|----------|------|
| DEBUG | 开发调试 | `logger.debug('Tool input:', input)` |
| INFO | 正常流程信息 | `logger.info('Tool executed successfully')` |
| WARN | 警告信息 | `logger.warn('API rate limit approaching')` |
| ERROR | 错误信息 | `logger.error('Tool execution failed', error)` |

### 4.2 日志格式

```typescript
// 格式: [时间] [级别] [模块] 消息
// 示例: [2024-01-15 10:30:45] [INFO] [AgentEngine] Tool-use loop started

enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}
```

### 4.3 日志使用规范

```typescript
// ✅ 正确：结构化日志
logger.info('Tool executed', {
  tool: toolName,
  duration: elapsed,
  success: true
});

// ❌ 错误：字符串拼接
logger.info('Tool ' + toolName + ' executed in ' + elapsed + 'ms');

// ✅ 正确：错误日志包含堆栈
logger.error('Operation failed', error);

// ❌ 错误：错误日志不包含上下文
logger.error('Operation failed');
```

### 4.4 日志模块实现

```typescript
// src/utils/logger.ts
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

class Logger {
  constructor(private module: string, private level: LogLevel = LogLevel.INFO) {}

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(`[${this.formatTime()}] [DEBUG] [${this.module}] ${message}`, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      console.info(`[${this.formatTime()}] [INFO] [${this.module}] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(`[${this.formatTime()}] [WARN] [${this.module}] ${message}`, ...args);
    }
  }

  error(message: string, error?: Error): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(`[${this.formatTime()}] [ERROR] [${this.module}] ${message}`, error);
    }
  }

  private formatTime(): string {
    return new Date().toISOString();
  }
}

export const logger = (module: string) => new Logger(module);
```

---

## 5. 代码提交规范

### 5.1 提交信息格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 5.2 Type 类型

| Type | 说明 | 示例 |
|------|------|------|
| feat | 新功能 | `feat(agent): add ToolUseLoop` |
| fix | Bug 修复 | `fix(bash): handle permission denied` |
| docs | 文档更新 | `docs: update README` |
| style | 代码格式 | `style: format code` |
| refactor | 重构 | `refactor(registry): improve performance` |
| test | 测试 | `test: add unit tests` |
| chore | 构建/工具 | `chore: update dependencies` |

### 5.3 Scope 范围

| Scope | 说明 |
|-------|------|
| cli | 命令行入口 |
| agent | Agent 引擎 |
| tools | 工具系统 |
| api | API 适配层 |
| ui | 用户界面 |
| auth | 认证模块 |
| config | 配置管理 |
| utils | 工具函数 |

### 5.4 提交示例

```bash
# 功能提交
git commit -m "feat(agent): implement Tool-Use Loop state machine

- Add ToolUseLoop class with state management
- Support tool execution and result handling
- Add max loop count protection

Closes #123"

# 修复提交
git commit -m "fix(bash): handle permission denied error

When user denies permission, return error result instead of throwing"

# 重构提交
git commit -m "refactor(registry): extract tool validation logic

- Move validation to separate function
- Add comprehensive error messages
- Improve testability"
```

---

## 6. TypeScript 规范

### 6.1 类型定义

```typescript
// ✅ 正确：使用 interface 定义对象结构
interface User {
  id: string;
  name: string;
  email: string;
}

// ✅ 正确：使用 type 定义联合类型或别名
type UserRole = 'admin' | 'user' | 'guest';
type UserId = string;

// ✅ 正确：使用枚举定义常量集合
enum PermissionChoice {
  YES = 'yes',
  NO = 'no',
  ALWAYS = 'always',
  LATER = 'later'
}

// ❌ 错误：使用字符串字面量
const PERMISSION_YES = 'yes';
```

### 6.2 类型注解

```typescript
// ✅ 正确：明确标注返回值类型
function add(a: number, b: number): number {
  return a + b;
}

// ✅ 正确：标注异步返回类型
async function fetchUser(id: string): Promise<User> {
  const response = await api.get(`/users/${id}`);
  return response.data;
}

// ✅ 正确：标注函数类型
type ExecuteFn = (input: unknown) => Promise<ToolResult>;
```

### 6.3 泛型约束

```typescript
// ✅ 正确：使用泛型约束
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

// ✅ 正确：泛型接口
interface Repository<T> {
  findById(id: string): Promise<T | null>;
  save(entity: T): Promise<T>;
}
```

### 6.4 Zod Schema 使用

```typescript
// ✅ 正确：使用 Zod 定义输入 Schema
import { z } from 'zod';

const BashToolInputSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().optional().default(30000)
});

// ✅ 正确：在工具中使用 Schema 验证
class BashTool implements Tool {
  inputSchema = BashToolInputSchema;

  async execute(input: unknown): Promise<ToolResult> {
    const validated = this.inputSchema.parse(input);
    // 执行逻辑
  }
}
```

---

## 7. 注释规范

### 7.1 JSDoc 注释

```typescript
/**
 * 注册一个工具到注册表
 * @param tool - 要注册的工具实例
 * @throws {ValidationError} 当工具格式不正确时
 * @example
 * const tool = new BashTool();
 * registry.register(tool);
 */
register(tool: Tool): void {
  // 实现
}
```

### 7.2 行内注释

```typescript
// ✅ 正确：解释为什么，而非做什么
// 使用 setTimeout 而非 setInterval，因为需要在下一次调用前重置
setTimeout(() => processNext(), delay);

// ❌ 错误：重复代码已说明的内容
// 增加计数器
counter++;

// ❌ 错误：无意义的注释
// 遍历数组
for (const item of items) {}
```

---

## 8. 导入导出规范

### 8.1 导入顺序

```typescript
// 1. Node.js 内置模块
import fs from 'fs';
import path from 'path';

// 2. 外部依赖
import { z } from 'zod';

// 3. 内部模块（@ 开头的别名）
import { AgentEngine } from '@/agent/AgentEngine';
import { ToolRegistry } from '@/tools/ToolRegistry';

// 4. 类型导入（放在最后）
import type { Tool, ToolResult } from '@/tools/base/Tool';
```

### 8.2 导出规范

```typescript
// ✅ 正确：命名导出
export const MAX_LOOP_COUNT = 100;
export class AgentEngine { }
export interface Tool { }

// ✅ 正确：默认导出（仅在单一导出时使用）
export default class ReplUI { }

// ❌ 错误：混用默认导出和命名导出
export default class Foo { }
export class Bar { }
```

---

## 9. 测试规范

### 9.1 单元测试结构

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { BashTool } from '@/tools/bash/BashTool';

describe('BashTool', () => {
  let tool: BashTool;

  beforeEach(() => {
    tool = new BashTool();
  });

  describe('execute', () => {
    it('should execute simple command', async () => {
      const result = await tool.execute({ command: 'echo hello' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('hello');
    });

    it('should handle command timeout', async () => {
      const result = await tool.execute({ 
        command: 'sleep 10', 
        timeout: 100 
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });
  });
});
```

### 9.2 测试命名

```typescript
// 测试文件: [模块名].test.ts
// 测试描述: should [预期行为] when [条件]
// 示例:
describe('ToolRegistry', () => {
  it('should return undefined when tool not found', () => {
    // test
  });

  it('should throw error when registering duplicate tool', () => {
    // test
  });
});
```
