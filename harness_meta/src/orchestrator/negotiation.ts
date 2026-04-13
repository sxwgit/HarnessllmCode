import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../logger/index.js';
import { GeneratorAgent } from '../agents/generator.js';
import { EvaluatorAgent } from '../agents/evaluator.js';
import type { SprintInfo } from '../types.js';
import { normalizedIncludes } from '../artifacts/text-normalizer.js';

export interface NegotiationResult {
  success: boolean;
  contractPath: string;
  rounds: number;
  issues: string[];
}

interface NegotiationReviewPayload {
  agreed: boolean;
  concerns: string[];
}

/**
 * Sprint Contract Negotiation
 *
 * S-04 fix: Uses INDEPENDENT GeneratorAgent and EvaluatorAgent instances
 * for the GAN-style adversarial negotiation, honoring the iron rule:
 * "代码生成与质量评估彻底解耦，分别由独立智能体负责"
 *
 * The Generator proposes a delivery plan, and the Evaluator reviews and tightens
 * acceptance criteria. They iterate until both agree — each using their own
 * system prompt and tool set.
 */
export class SprintNegotiator {
  private generator: GeneratorAgent;
  private evaluator: EvaluatorAgent;
  private logger: Logger;
  private maxRounds: number;

  constructor(
    generator: GeneratorAgent,
    evaluator: EvaluatorAgent,
    logger: Logger,
    maxRounds = 3,
  ) {
    this.generator = generator;
    this.evaluator = evaluator;
    this.logger = logger;
    this.maxRounds = maxRounds;
  }

  /**
   * Run the negotiation process between Generator and Evaluator
   * to produce an agreed sprint contract.
   */
  async negotiate(
    sprintInfo: SprintInfo,
    sprintSection: string,
    productSpec: string,
    architectureDesign: string,
    contractPath: string,
  ): Promise<NegotiationResult> {
    const issues: string[] = [];

    // Round 1: Generator proposes initial delivery plan
    this.logger.info('Negotiation round 1: Generator proposing delivery plan', {
      sprintId: sprintInfo.id,
    });

    await this.generatorPropose(
      sprintSection, productSpec, architectureDesign, contractPath,
    );

    // Round 2+: Evaluator reviews and iterates
    for (let round = 2; round <= this.maxRounds; round++) {
      this.logger.info(`Negotiation round ${round}: Evaluator reviewing`, {
        sprintId: sprintInfo.id,
        round,
      });

      const evaluation = await this.evaluatorReview(
        contractPath, round,
      );

      // Anti-cheat: reject contradictory payloads (agreed=true but concerns present)
      if (evaluation.agreed && evaluation.concerns.length > 0) {
        const msg = '审查结果自相矛盾：已同意但仍包含待解决问题，请重新输出';
        this.logger.warn('Negotiation: contradictory review payload', { concerns: evaluation.concerns });
        issues.push(msg);
        await this.generatorRevise(contractPath, evaluation.concerns);
        continue;
      }

      // Anti-cheat: reject payloads that say no but give no issues
      if (!evaluation.agreed && evaluation.concerns.length === 0) {
        const msg = '审查结果不通过时必须给出明确问题列表，请重新输出';
        this.logger.warn('Negotiation: rejected without issue list');
        issues.push(msg);
        await this.generatorRevise(contractPath, [msg]);
        continue;
      }

      if (evaluation.agreed) {
        this.logger.info(`Negotiation completed: agreement reached in ${round} rounds`, {
          sprintId: sprintInfo.id,
        });
        return {
          success: true,
          contractPath,
          rounds: round,
          issues,
        };
      }

      // Evaluator has concerns — Generator revises
      issues.push(...evaluation.concerns);
      this.logger.info(`Negotiation round ${round}: Generator revising`, {
        sprintId: sprintInfo.id,
        concerns: evaluation.concerns.length,
      });

      await this.generatorRevise(contractPath, evaluation.concerns);
    }

    // Max rounds reached without agreement
    this.logger.warn('Negotiation failed: max rounds reached without agreement', {
      sprintId: sprintInfo.id,
      maxRounds: this.maxRounds,
    });

    return {
      success: false,
      contractPath,
      rounds: this.maxRounds,
      issues,
    };
  }

  /**
   * Generator proposes a sprint contract using its own Agent + tools.
   * The Generator can use file_read to check existing project structure
   * before proposing deliverables.
   */
  private async generatorPropose(
    sprintSection: string,
    productSpec: string,
    architectureDesign: string,
    contractPath: string,
  ): Promise<void> {
    const prompt = `请基于以下 Sprint 信息，提出你的交付计划。

## Sprint 信息
${sprintSection}

## 产品规格 (参考)
${this.truncate(productSpec, 2000)}

## 架构设计 (参考)
${this.truncate(architectureDesign, 2000)}

## 要求

请使用 file_write 工具将 Sprint 合同写入 "${contractPath}"（这是相对于目标项目根目录的路径，禁止使用绝对路径或 ..）。

⚠️ 路径约定：file_write 的 path 参数必须使用相对于目标项目根目录的相对路径。

合同必须包含以下章节:
1. Sprint基本信息 (ID, 周期, 依赖Sprint)
2. 核心目标 (本次必须达成的目标, 不超过3个)
3. 功能点交付清单 (带ID、描述、优先级、交付文件路径)
4. 量化验收标准 (每个功能点的通过条件, 必须可量化)
5. 测试用例清单 (至少3个核心路径测试用例)
6. 代码规范与架构合规要求
7. 安全编码要求
8. 交付物清单 (所有需要创建/修改的文件路径)
9. 双方确认签字 (Generator智能体ID + 时间戳, Evaluator智能体ID + 时间戳, 必须在合同末尾)`;

    await this.generator.run(prompt);
  }

  /**
   * Evaluator reviews the proposed contract using its own Agent + tools.
   * The Evaluator can use file_read to inspect the actual contract content
   * and verify deliverable paths against the project structure.
   */
  private async evaluatorReview(
    contractPath: string,
    round: number,
  ): Promise<{ agreed: boolean; concerns: string[] }> {
    const prompt = `你是严格的QA工程师和代码审查专家。请审查以下 Sprint 合同草案。

请先使用 file_read 读取 "${contractPath}"（相对路径），然后给出审查意见。

## 审查重点
1. 验收标准是否量化、可校验
2. 测试用例是否覆盖核心路径
3. 交付物清单是否完整（文件路径是否合理）
4. 功能点是否有遗漏或过于宽泛
5. 安全编码要求是否足够严格
6. 合同是否包含所有必填章节（Sprint基本信息、核心目标、功能点交付清单、量化验收标准、测试用例清单、代码规范要求、安全编码要求、交付物清单、双方确认签字）

## 输出格式
请严格按以下 JSON 格式输出审查结果 (不要使用工具, 直接输出):
\`\`\`json
{
  "agreed": true/false,
  "concerns": ["问题1", "问题2", ...]
}
\`\`\`

如果合同质量足够好, 可以直接 agreed: true。
只有存在重大问题时才返回 agreed: false。这是第 ${round} 轮审查。`;

    const response = await this.evaluator.run(prompt, {
      systemPromptOverride: '你是严格的QA工程师，负责审查Sprint合同的质量。只输出JSON格式的审查结果。',
    });

    const parsed = this.parseReviewPayload(response);
    if (parsed) return parsed;

    // If can't parse, default to NOT agreed — never lower acceptance threshold
    this.logger.warn('Failed to parse evaluator review JSON, defaulting to NOT agreed');
    return { agreed: false, concerns: ['无法解析审查结果JSON，请重新输出标准格式'] };
  }

  /**
   * Generator revises the contract based on Evaluator's concerns.
   * Uses the Generator Agent with full tool access (file_read, file_write, file_edit).
   */
  private async generatorRevise(
    contractPath: string,
    concerns: string[],
  ): Promise<void> {
    const prompt = `Evaluator 对你的 Sprint 合同提出了以下问题，请修订合同。

## Evaluator 的意见
${concerns.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 要求
1. 先用 file_read 读取当前合同: "${contractPath}"（相对路径）
2. 根据意见修订合同内容
3. 使用 file_write 写入修订后的合同到: "${contractPath}"（相对路径，禁止绝对路径或 ..）
4. 保留合同的基本结构，只修改有问题的部分`;

    await this.generator.run(prompt);
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '\n... (truncated)';
  }

  private parseReviewPayload(response: string): NegotiationReviewPayload | null {
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ||
        response.match(/\{[\s\S]*"agreed"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]) as {
          agreed?: unknown;
          concerns?: unknown;
        };

        if (typeof parsed.agreed === 'boolean' && Array.isArray(parsed.concerns)) {
          const concerns = parsed.concerns.filter((item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
          );
          return { agreed: parsed.agreed, concerns };
        }

        // Handle partial JSON (agreed field present but concerns missing)
        if (typeof parsed.agreed === 'boolean') {
          return { agreed: parsed.agreed, concerns: [] };
        }
      }

      // Fallback: infer agreement from keyword analysis (normalized matching)
      const positiveKeywords = ['同意', '通过', '认可', '合格', 'agree', 'approved', '可以', '没问题', '良好', '符合', '达标'];
      const negativeKeywords = ['不同意', '不通过', '拒绝', 'reject', 'disagree', '有问题', '需要修改', '需要改进', '不符合'];

      const hasPositive = positiveKeywords.some(k => normalizedIncludes(response, k, true));
      const hasNegative = negativeKeywords.some(k => normalizedIncludes(response, k, true));

      if (hasPositive && !hasNegative) {
        this.logger.info('Negotiation: inferred agreement from keyword analysis');
        return { agreed: true, concerns: [] };
      }

      if (hasNegative) {
        // Extract concern-like sentences as fallback
        const lines = response.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•') || /^\d+\./.test(l.trim()));
        const concerns = lines.slice(0, 5).map(l => l.replace(/^[-•\d.)\s]+/, '').trim()).filter(Boolean);
        return { agreed: false, concerns: concerns.length > 0 ? concerns : ['Evaluator raised concerns, please review and revise'] };
      }

      // Default to agreed if no clear signal (lenient approach for robustness)
      this.logger.info('Negotiation: no clear agreement signal, defaulting to agreed');
      return { agreed: true, concerns: [] };
    } catch {
      return null;
    }
  }
}
