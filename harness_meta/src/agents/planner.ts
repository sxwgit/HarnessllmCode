import { BaseAgent } from './base.js';
import { LLMClient } from '../llm/client.js';
import { ToolRegistry } from '../tools/registry.js';

export class PlannerAgent extends BaseAgent {
  constructor(client: LLMClient, toolRegistry: ToolRegistry) {
    super('planner', client, toolRegistry);
  }

  /**
   * Generate all 5 design documents from the standard requirement
   */
  async plan(standardRequirement: string, onText?: (text: string) => void): Promise<string> {
    const message = `请基于以下标准化需求文档，生成完整的工程设计方案。

⚠️ 路径约定：所有 file_write 的 path 参数必须使用相对于目标项目根目录的相对路径，禁止使用绝对路径或 .. 逃逸。

将以下 5 份文档写入（使用相对路径）：
1. docs/plan/product_spec.md - 产品规格说明书
2. docs/plan/architecture_design.md - 架构设计文档
3. docs/plan/project_structure.md - 项目结构文档
4. docs/plan/code_standard.md - 代码规范文档
5. docs/plan/sprint_plan.md - Sprint计划文档

## 标准化需求文档

${standardRequirement}

请使用 file_write 工具逐一创建这 5 份文档（path 参数直接使用上面的相对路径，如 "docs/plan/product_spec.md"）。每份文档必须包含完整的章节内容，使用 Markdown 格式。`;

    return this.run(message, {
      onText,
      lightweightContext: message,
    });
  }
}
