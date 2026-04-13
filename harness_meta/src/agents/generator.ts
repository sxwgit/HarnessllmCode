import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseAgent } from './base.js';
import { LLMClient } from '../llm/client.js';
import { ToolRegistry } from '../tools/registry.js';

export class GeneratorAgent extends BaseAgent {
  private targetDir: string;

  constructor(client: LLMClient, toolRegistry: ToolRegistry, targetDir: string) {
    super('generator', client, toolRegistry);
    this.targetDir = targetDir;
  }

  async develop(
    sprintId: string,
    sprintContract: string,
    architectureDesign: string,
    codeStandard: string,
    existingCodeSummary: string,
    onText?: (text: string) => void,
  ): Promise<string> {
    const message = `请严格按照 Sprint 合同要求完成代码开发。

⚠️ 路径约定：所有工具（file_write, file_read, file_edit, glob, grep, bash）的 path 参数必须使用相对于目标项目根目录的相对路径。
- 正确示例：path: "src/index.ts", path: "docs/plan/architecture_design.md"
- 禁止使用绝对路径（如 "<workspace-path>"）
- 禁止使用 .. 逃逸目标项目目录

## Sprint 合同

${sprintContract}

## 架构设计 (关键要点)

${this.truncate(architectureDesign, 3000)}

## 代码规范

${this.truncate(codeStandard, 2000)}

## 当前项目已有代码概况

${existingCodeSummary || '(这是第一个Sprint，项目尚无业务代码)'}

## 开发要求

1. 首先用 file_read 查看已有的项目文件结构（path 如 "docs/plan/project_structure.md"）
2. 按功能优先级逐一实现
3. 所有文件写入正确的相对目录路径（如 "src/core/engine.ts"）
4. 实现完成后用 bash 执行基础验证（如 npx tsc --noEmit 或 node --check）
5. 如需安装依赖，使用 bash 执行 npm install
6. 开发完成后，输出自检查报告到 docs/sprint/self_check_report_${sprintId}.md（使用相对路径）
   报告内容包括：已实现功能点清单、语法检查结果、编译验证结果、发现的问题及处理方式`;

    return this.run(message, {
      onText,
      lightweightContext: message,
      sprintId,
    });
  }

  async fix(
    reviewReport: string,
    sprintContract: string,
    iteration: number,
    onText?: (text: string) => void,
  ): Promise<string> {
    const message = `请根据验收评审报告修复代码问题。这是第 ${iteration} 次修复迭代。

⚠️ 路径约定：所有工具的 path 参数必须使用相对于目标项目根目录的相对路径，禁止绝对路径和 .. 逃逸。

## 验收评审报告

${reviewReport}

## Sprint 合同 (参考)

${this.truncate(sprintContract, 2000)}

## 修复要求

1. 使用 file_read 逐一阅读报告中有问题的文件（path 如 "src/core/engine.ts"）
2. 使用 file_edit 精准修复每个问题（path 使用相对路径）
3. 严禁修改非问题相关的代码
4. 修复完成后用 bash 执行验证
5. 确保修复后的代码能通过验收`;

    return this.run(message, {
      onText,
      lightweightContext: message,
      sprintId: this.extractSprintIdFromContract(sprintContract),
    });
  }

  private extractSprintIdFromContract(sprintContract: string): string | undefined {
    const match = sprintContract.match(/sprint-\d+/i);
    return match?.[0]?.toLowerCase();
  }
}
