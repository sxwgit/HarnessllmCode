import { BaseAgent } from './base.js';
import { LLMClient } from '../llm/client.js';
import { ToolRegistry } from '../tools/registry.js';

export class EvaluatorAgent extends BaseAgent {
  constructor(client: LLMClient, toolRegistry: ToolRegistry) {
    super('evaluator', client, toolRegistry);
  }

  async evaluate(
    sprintContract: string,
    architectureDesign: string,
    codeStandard: string,
    sprintId: string,
    onText?: (text: string) => void,
  ): Promise<string> {
    const message = `请对当前 Sprint 的代码进行全维度验收评估。

⚠️ 路径约定：所有工具（file_read, file_write, glob, grep, bash）的 path 参数必须使用相对于目标项目根目录的相对路径。
- 正确示例：path: "src/index.ts", path: "docs/sprint/review_report_sprint-01.md"
- 禁止使用绝对路径（如 "<workspace-path>"）
- 禁止使用 .. 逃逸目标项目目录

## Sprint 合同

${sprintContract}

## 架构设计 (参考)

${this.truncate(architectureDesign, 2000)}

## 代码规范 (参考)

${this.truncate(codeStandard, 1500)}

## Sprint ID: ${sprintId}

## 验收流程

1. 使用 glob 查看项目文件结构（path 参数使用相对路径）
2. 使用 file_read 逐一检查所有源代码文件（path 参数如 "src/index.ts"）
3. 使用 bash 执行语法检查和编译验证
4. 使用 bash 运行测试用例（如果有）
5. 检查代码是否符合架构设计和代码规范
6. 按 5 维度严格打分
7. 使用 file_write 将验收报告写入 "docs/sprint/review_report_${sprintId}.md"（这是相对于目标项目根目录的路径）

## 硬阈值提醒
- 任何维度 < 6分 → 不通过
- 整体加权平均分 < 7分 → 不通过
- 核心功能缺失 → 功能完整性 0分`;

    return this.run(message, {
      onText,
      lightweightContext: message,
      sprintId,
    });
  }

}
