import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../logger/index.js';
import {
  StandardRequirementSchema,
  ProductSpecSchema,
  ArchitectureDesignSchema,
  SprintPlanSchema,
  SprintContractSchema,
  ReviewReportSchema,
} from './schemas.js';
import { normalizedIncludes } from './text-normalizer.js';
import {
  SPRINT_CONTRACT_REQUIRED_SECTIONS,
  REVIEW_REPORT_REQUIRED_SECTIONS,
  EVALUATION_DIMENSIONS,
  matchAnyKeyword,
  dimensionAlternation,
  dimensionNormalizedAlternation,
} from './validation-registry.js';

export interface ValidationResult {
  valid: boolean;
  file: string;
  errors: string[];
  warnings: string[];
}

/**
 * D-05 fix: ArtifactValidator now uses Zod schemas for structural validation
 * instead of relying solely on keyword-string matching.
 *
 * Validation strategy:
 * 1. Parse file content as Markdown → extract structured sections
 * 2. Map sections to the corresponding Zod schema fields
 * 3. Validate against the schema for type completeness and required fields
 * 4. Fall back to keyword check for sections that can't be parsed structurally
 */
export class ArtifactValidator {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Validate a single artifact file using both Zod schema and keyword checks
   */
  validateFile(filePath: string): ValidationResult {
    const fileName = filePath.split('/').pop() || '';
    const artifactType = this.normalizeArtifactType(fileName);
    const result: ValidationResult = { valid: true, file: filePath, errors: [], warnings: [] };

    if (!existsSync(filePath)) {
      result.valid = false;
      result.errors.push(`File does not exist: ${filePath}`);
      return result;
    }

    const content = readFileSync(filePath, 'utf-8');

    // Check for empty/placeholder content
    if (content.length < 100) {
      result.warnings.push('File content is suspiciously short (< 100 chars)');
    }

    // Check for excessive TODO/TBD placeholders
    const todoMatches = content.match(/TODO|FIXME|TBD|待填写|待补充/g);
    if (todoMatches && todoMatches.length > 3) {
      result.errors.push(`Contains ${todoMatches.length} placeholder markers (TODO/FIXME/TBD) — exceeds limit of 3`);
      result.valid = false;
    }

    // Run Zod schema validation for known artifact types
    const schemaValidation = this.validateWithSchema(artifactType, content);
    if (!schemaValidation.valid) {
      result.errors.push(...schemaValidation.errors);
      result.valid = false;
    }

    const semanticValidation = this.validateSemantics(artifactType, content);
    if (!semanticValidation.valid) {
      result.errors.push(...semanticValidation.errors);
      result.valid = false;
    }

    this.logger.info('Artifact validated', {
      file: fileName,
      valid: result.valid,
      errors: result.errors.length,
      warnings: result.warnings.length,
    });

    return result;
  }

  /**
   * Validate all planning documents exist and pass schema validation
   */
  validatePlanningDocs(planDir: string): ValidationResult[] {
    const requiredFiles = [
      'product_spec.md',
      'architecture_design.md',
      'project_structure.md',
      'code_standard.md',
      'sprint_plan.md',
    ];

    const results: ValidationResult[] = [];
    for (const file of requiredFiles) {
      const filePath = resolve(planDir, file);
      const result = this.validateFile(filePath);
      results.push(result);
    }

    const allValid = results.every(r => r.valid);
    this.logger.info('Planning documents validation complete', {
      totalFiles: results.length,
      valid: allValid,
    });

    return results;
  }

  /**
   * Validate a sprint contract using the SprintContractSchema
   */
  validateSprintContract(contractPath: string): ValidationResult {
    const result = this.validateFile(contractPath);
    if (!result.valid) return result;

    const content = readFileSync(contractPath, 'utf-8');

    // Use Zod schema for structural validation
    const schemaResult = this.validateWithSchema('sprint_contract', content);
    if (!schemaResult.valid) {
      result.errors.push(...schemaResult.errors);
      result.valid = false;
    }

    // Keyword check for sections that Zod can't validate from Markdown
    // Uses normalizedIncludes to handle whitespace/fullwidth/case variations
    for (const keyword of SPRINT_CONTRACT_REQUIRED_SECTIONS) {
      if (!normalizedIncludes(content, keyword)) {
        result.errors.push(`Missing required section keyword: "${keyword}"`);
        result.valid = false;
      }
    }

    // Check for excessive TBD markers (relaxed limit: LLM-generated contracts may have reasonable TBDs)
    const tbdMatches = content.match(/TBD|待确认/g);
    if (tbdMatches && tbdMatches.length > 5) {
      result.errors.push(`Contains ${tbdMatches.length} TBD/待确认 markers — exceeds limit of 5`);
      result.valid = false;
    }

    return result;
  }

  /**
   * Validate a review report using the ReviewReportSchema
   */
  validateReviewReport(reportPath: string): ValidationResult {
    const result = this.validateFile(reportPath);
    if (!result.valid) return result;

    const content = readFileSync(reportPath, 'utf-8');

    // Use Zod schema for structural validation
    const schemaResult = this.validateWithSchema('review_report', content);
    if (!schemaResult.valid) {
      result.errors.push(...schemaResult.errors);
      result.valid = false;
    }

    // Keyword check for required sections
    for (const keyword of REVIEW_REPORT_REQUIRED_SECTIONS) {
      if (!normalizedIncludes(content, keyword)) {
        result.errors.push(`Missing required section keyword: "${keyword}"`);
        result.valid = false;
      }
    }

    return result;
  }

  /**
   * D-05 core: Validate artifact content using Zod schemas
   * Attempts to parse Markdown content into a structured object and validate against the schema.
   */
  private validateWithSchema(fileName: string, content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Select schema based on file name
    let schema: import('zod').ZodType<unknown> | null = null;
    let artifactName: string;

    switch (fileName) {
      case 'standard_requirement.md':
        schema = StandardRequirementSchema;
        artifactName = 'StandardRequirement';
        break;
      case 'product_spec.md':
        schema = ProductSpecSchema;
        artifactName = 'ProductSpec';
        break;
      case 'architecture_design.md':
        schema = ArchitectureDesignSchema;
        artifactName = 'ArchitectureDesign';
        break;
      case 'sprint_plan.md':
        schema = SprintPlanSchema;
        artifactName = 'SprintPlan';
        break;
      case 'sprint_contract':
        schema = SprintContractSchema;
        artifactName = 'SprintContract';
        break;
      case 'review_report':
        schema = ReviewReportSchema;
        artifactName = 'ReviewReport';
        break;
      default:
        // No schema for this file type — skip Zod validation
        return { valid: true, errors: [] };
    }

    // Attempt to extract structured data from Markdown content
    const extracted = this.extractStructuredData(content, artifactName);

    try {
      schema.parse(extracted);
    } catch (err) {
      if (err instanceof Error && 'errors' in err) {
        const zodErr = err as { errors: Array<{ path: (string | number)[]; message: string }> };
        for (const issue of zodErr.errors) {
          errors.push(`Schema validation [${artifactName}].${issue.path.join('.')}: ${issue.message}`);
        }
      } else {
        errors.push(`Schema validation failed for ${artifactName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private validateSemantics(fileName: string, content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    switch (fileName) {
      case 'standard_requirement.md': {
        const requirement = this.extractStructuredData(content, 'StandardRequirement') as {
          projectName?: string;
          overview?: string;
          coreFeatures?: unknown[];
          techStack?: { runtime?: string; language?: string };
        };

        if (!requirement.projectName || requirement.projectName === 'unknown') {
          errors.push('Standard requirement must define an explicit project name');
        }
        if (!requirement.overview || requirement.overview.trim().length < 10) {
          errors.push('Standard requirement must define a concrete project overview');
        }
        if (!Array.isArray(requirement.coreFeatures) || requirement.coreFeatures.length === 0) {
          errors.push('Standard requirement must define at least one core feature');
        }
        if (!requirement.techStack?.runtime || !requirement.techStack?.language) {
          errors.push('Standard requirement must define concrete tech stack constraints');
        }
        if (!this.extractSection(content, '不做范围') && !this.extractSection(content, '需求边界')) {
          errors.push('Standard requirement must define an explicit out-of-scope section');
        }
        break;
      }
      case 'product_spec.md': {
        const features = this.extractProductFeatures(content);
        const userStories = this.extractListStrings(content, '用户故事与验收标准');
        if (features.length === 0) {
          errors.push('Product spec must define at least one core feature');
        }
        if (userStories.length === 0) {
          errors.push('Product spec must define at least one user story with acceptance criteria');
        }
        break;
      }
      case 'sprint_plan.md': {
        const sprintMatches = content.match(/\bsprint-\d+\b/gi) || [];
        if (sprintMatches.length === 0) {
          errors.push('Sprint plan must define at least one sprint identifier');
        }
        if (!normalizedIncludes(content, '里程碑') && !normalizedIncludes(content, 'milestone', true)) {
          errors.push('Sprint plan must define milestone information');
        }
        break;
      }
      case 'review_report': {
        const review = this.extractStructuredData(content, 'ReviewReport') as {
          sprintId?: string;
          scores?: unknown[];
          weightedAverage?: number;
          passed?: boolean;
          issues?: Array<{
            id?: string;
            file?: string;
            line?: number;
            rootCause?: string;
            fixSuggestion?: string;
          }>;
        };

        if (!review.sprintId) {
          errors.push('Review report must include a sprint identifier');
        }
        if (!Array.isArray(review.scores) || review.scores.length !== 5) {
          errors.push('Review report must include all 5 scoring dimensions');
        }
        if (typeof review.weightedAverage !== 'number' || Number.isNaN(review.weightedAverage)) {
          errors.push('Review report must include a valid weighted average score');
        }
        if (!normalizedIncludes(content, '验收结果')) {
          errors.push('Review report must include an explicit acceptance result section');
        }
        if (!review.passed && !normalizedIncludes(content, '不通过')) {
          errors.push('Review report must explicitly mark failing conclusions when not passed');
        }
        for (const issue of review.issues ?? []) {
          const issueId = issue.id || 'unknown';
          if (!issue.file || issue.line === undefined) {
            errors.push(`Review issue ${issueId} must include a concrete file path and line number`);
          }
          if (!issue.rootCause || issue.rootCause.trim().length < 8) {
            errors.push(`Review issue ${issueId} must include an explicit root cause`);
          }
          if (!issue.fixSuggestion || issue.fixSuggestion.trim().length < 8) {
            errors.push(`Review issue ${issueId} must include a concrete fix suggestion`);
          }
        }
        break;
      }
      default:
        break;
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Public entry point for extracting structured data from a review report.
   * Used by Harness for deterministic evaluation result checking.
   */
  extractReviewReportData(content: string): {
    sprintId: string;
    passed: boolean;
    scores: Array<{ dimension: string; score: number }>;
    weightedAverage: number;
  } {
    const raw = this.extractStructuredData(content, 'ReviewReport') as {
      sprintId?: string;
      passed?: boolean;
      scores?: Array<{ dimension: string; score: number }>;
      weightedAverage?: number;
    };

    return {
      sprintId: raw.sprintId ?? '',
      passed: raw.passed ?? false,
      scores: raw.scores ?? [],
      weightedAverage: typeof raw.weightedAverage === 'number' ? raw.weightedAverage : NaN,
    };
  }

  /**
   * Extract structured data from Markdown content for Zod validation.
   * This is a heuristic extractor — it converts Markdown sections to a JS object
   * that can be validated by the Zod schemas.
   */
  private extractStructuredData(content: string, artifactName: string): Record<string, unknown> {
    switch (artifactName) {
      case 'StandardRequirement': {
        // Extract basic fields from requirement doc
        const projectName = this.extractRequirementProjectName(content);
        const overview = this.extractSection(content, '概述') || this.extractSection(content, '项目概述') || '';
        const techStack = this.extractRequirementTechStack(content);
        return {
          projectName,
          overview,
          coreFeatures: this.extractStandardRequirementFeatures(content),
          techStack,
          constraints: this.extractListStrings(content, '约束条件'),
          outOfScope: this.extractListStrings(content, '不做范围'),
        };
      }
      case 'ProductSpec': {
        const features = this.extractProductFeatures(content);
        const boundaryItems = this.extractListStrings(content, '需求边界与不做范围');
        const userStoryItems = this.extractListStrings(content, '用户故事与验收标准');

        return {
          overview: this.extractSection(content, '产品概述') || this.extractSection(content, '概述') || '',
          targetUsers: this.extractSection(content, '目标用户') || '',
          coreValue: this.extractSection(content, '核心价值') || '',
          features,
          userStories: userStoryItems.map(story => ({
            story,
            acceptanceCriteria: [story],
          })),
          nonFunctionalRequirements: {
            performance: this.extractSection(content, '性能') || '',
            compatibility: this.extractSection(content, '兼容性') || '',
            maintainability: this.extractSection(content, '可维护性') || '',
            security: this.extractSection(content, '安全') || '',
          },
          boundaries: {
            inScope: features.map(feature => String(feature.name)),
            outOfScope: boundaryItems,
            futureScope: [],
          },
        };
      }
      case 'ArchitectureDesign': {
        const layerSection = this.extractSection(content, '架构层次')
          || this.extractSection(content, '分层架构')
          || this.extractSection(content, '系统分层')
          || '';
        const moduleSection = this.extractSection(content, '核心模块')
          || this.extractSection(content, '模块设计')
          || this.extractSection(content, '模块划分')
          || '';
        const modelSection = this.extractSection(content, '数据模型')
          || this.extractSection(content, '数据结构')
          || '';
        const techSection = this.extractSection(content, '技术栈')
          || this.extractSection(content, '技术选型')
          || '';

        const layers = this.extractListStrings(content, '架构层次').length > 0
          ? this.extractListStrings(content, '架构层次').map(item => ({
              name: item.split(/[:：]/)[0]?.trim() || item,
              responsibility: item.split(/[:：]/).slice(1).join(':').trim() || item,
              components: [],
            }))
          : this.extractListStrings(content, '分层架构').map(item => ({
              name: item.split(/[:：]/)[0]?.trim() || item,
              responsibility: item.split(/[:：]/).slice(1).join(':').trim() || item,
              components: [],
            }));

        const coreModules = this.extractListStrings(content, '核心模块').length > 0
          ? this.extractListStrings(content, '核心模块').map(item => ({
              name: item.split(/[:：]/)[0]?.trim() || item,
              responsibility: item.split(/[:：]/).slice(1).join(':').trim() || item,
              interfaces: [],
              dependencies: [],
            }))
          : this.extractListStrings(content, '模块设计').map(item => ({
              name: item.split(/[:：]/)[0]?.trim() || item,
              responsibility: item.split(/[:：]/).slice(1).join(':').trim() || item,
              interfaces: [],
              dependencies: [],
            }));

        const dataModels = this.extractListStrings(content, '数据模型').length > 0
          ? this.extractListStrings(content, '数据模型').map(item => ({
              name: item.split(/[:：]/)[0]?.trim() || item,
              fields: [],
            }))
          : this.extractListStrings(content, '数据结构').map(item => ({
              name: item.split(/[:：]/)[0]?.trim() || item,
              fields: [],
            }));

        const techItems = techSection.split('\n').map(l => l.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
        const runtime = techItems.find(i => /runtime|运行时/i.test(i))?.split(/[:：]/).slice(1).join(':').trim() || '';
        const language = techItems.find(i => /language|语言/i.test(i))?.split(/[:：]/).slice(1).join(':').trim() || '';
        const frameworkPairs = techItems.filter(i => /framework|框架/i.test(i));
        const frameworks: Record<string, string> = {};
        for (const fw of frameworkPairs) {
          const parts = fw.split(/[:：]/).slice(1).join(':').trim();
          if (parts) frameworks[parts] = parts;
        }

        return {
          overallArchitecture: this.extractSection(content, '整体架构') || this.extractSection(content, '架构概述') || '',
          layers,
          coreModules,
          dataModels,
          techStack: {
            runtime: runtime || 'unspecified',
            language: language || 'unspecified',
            frameworks,
            devTools: [],
          },
        };
      }
      case 'SprintPlan': {
        // Extract sprint entries from sections matching "Sprint" headers
        const sprintHeaders = content.match(/^#{2,4}\s+.*sprint-\d+.*$/gim) || [];
        const sprints = sprintHeaders.map((header, index) => {
          const idMatch = header.match(/sprint-\d+/i);
          const id = idMatch?.[0] ?? `sprint-${index + 1}`;
          // Extract the section content under this header
          const sectionContent = this.extractSprintPlanSection(content, id);
          const goals = sectionContent
            ? this.extractListStringsFromSection(sectionContent, '目标').length > 0
              ? this.extractListStringsFromSection(sectionContent, '目标')
              : this.extractListStringsFromSection(sectionContent, '目标')
            : [];
          const deliverables = sectionContent
            ? this.extractListStringsFromSection(sectionContent, '交付')
            : [];
          const effortMatch = sectionContent?.match(/(?:工作量|effort|复杂度)[:：\s]*(\d+)/i);
          return {
            id,
            name: header.replace(/^#+\s*/, '').trim(),
            priority: index + 1,
            goals,
            deliverables,
            estimatedEffort: effortMatch ? parseInt(effortMatch[1]) : 5,
            dependencies: [],
            acceptanceCriteria: [],
          };
        });

        // Extract milestones
        const milestoneStrings = this.extractListStrings(content, '里程碑');
        const milestones = milestoneStrings.map(item => ({
          name: item,
          tag: item.match(/v\d+\.\d+\.\d+/)?.[0] || '',
          sprints: item.match(/sprint-\d+/gi)?.map(s => s.toLowerCase()) || [],
        }));

        return {
          sprints: sprints.length > 0 ? sprints : this.extractListStrings(content, 'Sprint').map((item, index) => ({
            id: item.match(/sprint-\d+/i)?.[0] ?? `sprint-${index + 1}`,
            name: item,
            priority: index + 1,
            goals: [],
            deliverables: [],
            estimatedEffort: 5,
            dependencies: [],
            acceptanceCriteria: [],
          })),
          milestones,
        };
      }
      case 'SprintContract': {
        const files = this.extractListStrings(content, '交付物');
        const features = this.extractSprintFeatures(content, files);

        return {
          sprintId: this.extractSprintId(content),
          goals: this.extractListStrings(content, '核心目标'),
          features,
          acceptanceCriteria: this.extractListStrings(content, '验收标准'),
          testCases: this.extractSprintTestCases(content),
          files,
        };
      }
      case 'ReviewReport': {
        const sprintId = this.extractSprintId(content);
        const scores = this.extractReviewScores(content);
        const weightedAverage = this.extractWeightedAverage(content);
        return {
          sprintId,
          passed: normalizedIncludes(content, '通过') && !normalizedIncludes(content, '不通过'),
          scores,
          weightedAverage,
          issues: this.extractReviewIssues(content),
        };
      }
      default:
        return {};
    }
  }

  /**
   * Extract text content from a Markdown section
   */
  private extractSection(content: string, heading: string): string | null {
    // Match ## heading or ### heading or # heading
    const pattern = new RegExp(`^(#{1,4})\\s+.*${heading}.*$`, 'm');
    const match = content.match(pattern);
    if (!match) return null;

    const matchedLevel = match[1].length; // Number of # characters
    const startIdx = match.index! + match[0].length;
    const rest = content.substring(startIdx);

    // Find next heading of the SAME level or higher (fewer #)
    // Subheadings (more #) should be included in the section
    const lines = rest.split('\n');
    let endIdx = 0;
    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,4})\s+/);
      if (headingMatch && headingMatch[1].length <= matchedLevel) {
        break;
      }
      endIdx += line.length + 1; // +1 for the newline
    }

    return rest.substring(0, endIdx).trim();
  }

  /**
   * Extract list items from a section (lines starting with - or * or numbered)
   */
  private extractListItems(content: string, sectionHint: string): Array<Record<string, string>> {
    const section = this.extractSection(content, sectionHint);
    if (!section) return [];

    const items: Array<Record<string, string>> = [];
    const lines = section.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      // Standard list items: - item, * item, 1. item
      if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        items.push({ description: trimmed.replace(/^[-*\d.)\s]+/, '') });
        continue;
      }

      // Markdown table rows: | cell1 | cell2 | cell3 |
      // Skip separator rows like |---|---|
      if (trimmed.startsWith('|') && !/^\|[\s\-:|]+\|$/.test(trimmed)) {
        const cells = trimmed.split('|')
          .map(c => c.trim())
          .filter(c => c.length > 0);
        if (cells.length > 0) {
          // Join all cells as the description, or use first meaningful cell
          const description = cells.join(' - ');
          items.push({ description });
        }
      }
    }
    return items;
  }

  private extractListStrings(content: string, sectionHint: string): string[] {
    return this.extractListItems(content, sectionHint)
      .map(item => item.description?.trim())
      .filter((item): item is string => Boolean(item));
  }

  private extractRequirementProjectName(content: string): string {
    const explicitSection = this.extractSection(content, '项目名称');
    if (explicitSection) {
      return explicitSection.split('\n')[0]?.replace(/^[-*]\s*/, '').trim() || 'unknown';
    }

    const titleMatch = content.match(/^#\s+(.+)$/m);
    return titleMatch?.[1]?.trim() || 'unknown';
  }

  private extractStandardRequirementFeatures(content: string): Array<{
    id: string;
    name: string;
    description: string;
    priority: 'P0' | 'P1' | 'P2';
  }> {
    return this.extractListStrings(content, '核心功能').map((item, index) => {
      const match = item.match(/^(?<id>[A-Za-z]+-?\d+)\s+(?<name>.+?)(?:\s+\((?<priority>P[0-2])\))?$/);
      const id = match?.groups?.id ?? `F-${String(index + 1).padStart(3, '0')}`;
      const name = (match?.groups?.name ?? item).trim();
      const priority = (match?.groups?.priority as 'P0' | 'P1' | 'P2' | undefined) ?? 'P1';

      return {
        id,
        name,
        description: item,
        priority,
      };
    });
  }

  private extractRequirementTechStack(content: string): {
    runtime: string;
    language: string;
    frameworks: string[];
    dependencies: string[];
  } {
    const techStackSection = this.extractSection(content, '技术栈要求') || this.extractSection(content, '技术栈') || '';

    // Normalize table rows to key-value pairs for extraction
    const normalizedLines = techStackSection.split('\n').map(line => {
      const trimmed = line.trim();
      // Table row: | **运行时** | Node.js 20+ | → "运行时: Node.js 20+"
      if (trimmed.startsWith('|') && !/^\|[\s\-:|]+\|$/.test(trimmed)) {
        const cells = trimmed.split('|').map(c => c.replace(/\*\*/g, '').trim()).filter(Boolean);
        if (cells.length >= 2) {
          return `${cells[0]}: ${cells.slice(1).join(', ')}`;
        }
      }
      return trimmed.replace(/^[-*]\s*/, '');
    }).filter(Boolean);

    const allText = normalizedLines.join('\n');
    const runtime = allText.match(/(?:runtime|运行时)[:\s]+(.+?)(?:\n|$)/i)?.[1]?.trim()
      || (normalizedLines.length > 0 ? 'specified-runtime' : '');
    const language = allText.match(/(?:language|语言|typescript|TypeScript)[:\s]*(.*)/i)?.[0]?.trim()
      || (normalizedLines.length > 0 ? 'specified-language' : '');
    const frameworks = normalizedLines
      .filter(item => /framework|框架/i.test(item))
      .map(item => item.split(/[:：]/).slice(1).join(':').trim())
      .filter(Boolean);
    const dependencies = normalizedLines
      .filter(item => /dependency|依赖/i.test(item))
      .map(item => item.split(/[:：]/).slice(1).join(':').trim())
      .filter(Boolean);

    // Fallback: if section mentions Node.js or TypeScript, infer runtime/language
    const runtimeFinal = runtime || (allText.match(/node\.?js/i) ? 'Node.js' : '');
    const languageFinal = language || (allText.match(/typescript/i) ? 'TypeScript' : '');

    return {
      runtime: runtimeFinal,
      language: languageFinal,
      frameworks,
      dependencies,
    };
  }

  private extractProductFeatures(content: string): Array<{
    id: string;
    name: string;
    description: string;
    priority: string;
    dependencies?: string[];
  }> {
    return this.extractListStrings(content, '核心功能').map((item, index) => {
      const match = item.match(/^(?<id>[A-Za-z]+-\d+)\s+(?<name>.+?)(?:\s+\((?<priority>P\d)\))?$/);
      const id = match?.groups?.id ?? `F-${String(index + 1).padStart(3, '0')}`;
      const name = (match?.groups?.name ?? item).trim();
      const priority = match?.groups?.priority ?? 'P1';

      return {
        id,
        name,
        description: item,
        priority,
        dependencies: [],
      };
    });
  }

  private extractSprintId(content: string): string {
    const explicitPatterns = [
      /-\s*Sprint\s+ID\s*[:：]\s*([A-Za-z0-9-_]+)/i,
      /-\s*Sprint\s*[:：]\s*([A-Za-z0-9-_]+)/i,
      /-\s*ID\s*[:：]\s*([A-Za-z0-9-_]+)/i,
    ];

    const basicInfoSection = this.extractSection(content, '验收基本信息') ?? this.extractSection(content, 'Sprint基本信息') ?? content;
    for (const pattern of explicitPatterns) {
      const match = basicInfoSection.match(pattern) ?? content.match(pattern);
      if (match?.[1]) return match[1];
    }

    return '';
  }

  private extractSprintFeatures(content: string, files: string[]): Array<{
    id: string;
    description: string;
    priority: string;
    deliverables: string[];
  }> {
    return this.extractListStrings(content, '功能点交付清单').map((item, index) => {
      const match = item.match(/^(?<id>[A-Za-z]+-\d+)\s*:\s*(?<description>.+)$/);
      return {
        id: match?.groups?.id ?? `F-${String(index + 1).padStart(3, '0')}`,
        description: (match?.groups?.description ?? item).trim(),
        priority: 'P1',
        deliverables: files,
      };
    });
  }

  private extractSprintTestCases(content: string): Array<{
    id: string;
    description: string;
    steps: string[];
    expectedResult: string;
  }> {
    return this.extractListStrings(content, '测试用例').map((item, index) => {
      const match = item.match(/^(?<id>[A-Za-z]+-\d+)\s*:\s*(?<description>.+)$/);
      const description = (match?.groups?.description ?? item).trim();
      return {
        id: match?.groups?.id ?? `TC-${String(index + 1).padStart(3, '0')}`,
        description,
        steps: [description],
        expectedResult: description,
      };
    });
  }

  private extractReviewScores(content: string): Array<{
    dimension: string;
    weight: number;
    score: number;
    maxScore: number;
    notes: string;
  }> {
    return EVALUATION_DIMENSIONS.flatMap(({ canonical, aliases }) => {
      const bulletMatch = aliases
        .map(alias => {
          const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return content.match(new RegExp(`[-*]\\s*${escaped}\\s*[:：]\\s*(\\d+\\.?\\d*)`, 'i'));
        })
        .find(Boolean);
      if (!bulletMatch) return [];

      return [{
        dimension: canonical,
        weight: 0,
        score: parseFloat(bulletMatch[1]),
        maxScore: 10,
        notes: '',
      }];
    });
  }

  private extractWeightedAverage(content: string): number {
    const match = content.match(/整体加权平均分[\s\S]*?(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : NaN;
  }

  private extractReviewIssues(content: string): Array<{
    id: string;
    severity: string;
    file?: string;
    line?: number;
    description: string;
    rootCause: string;
    fixSuggestion: string;
  }> {
    return this.extractListStrings(content, '问题清单').map((item, index) => {
      const issueId = item.match(/([A-Za-z]+-\d+)/)?.[1] ?? `ISSUE-${index + 1}`;
      const fileMatch = item.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/);
      const rootCauseMatch = item.match(/(?:root cause|根因|原因)[:：]\s*(.+?)(?=(?:fix suggestion|修复建议|修复方案|修复)[:：]|$)/i);
      const fixSuggestionMatch = item.match(/(?:fix suggestion|修复建议|修复方案|修复)[:：]\s*(.+)$/i);
      return {
        id: issueId,
        severity: 'normal',
        file: fileMatch?.[1],
        line: fileMatch?.[2] ? parseInt(fileMatch[2], 10) : undefined,
        description: item,
        rootCause: rootCauseMatch?.[1]?.trim() ?? '',
        fixSuggestion: fixSuggestionMatch?.[1]?.trim() ?? '',
      };
    });
  }

  /**
   * Extract a section of content under a specific sprint header in a sprint plan.
   */
  private extractSprintPlanSection(content: string, sprintId: string): string | null {
    const escaped = sprintId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headerPattern = new RegExp(`^#{2,4}\\s+.*${escaped}.*$`, 'im');
    const headerMatch = content.match(headerPattern);
    if (!headerMatch || headerMatch.index === undefined) return null;

    const startIdx = headerMatch.index + headerMatch[0].length;
    const rest = content.substring(startIdx);
    const nextHeader = rest.match(/^#{1,4}\s+.*sprint-\d+/im);
    const endIdx = nextHeader ? nextHeader.index! : rest.length;

    return rest.substring(0, endIdx).trim();
  }

  /**
   * Extract list strings from a given section text (not from the full document).
   */
  private extractListStringsFromSection(sectionText: string, hint: string): string[] {
    // First try to find a sub-section matching the hint
    const subSection = this.extractSectionFromText(sectionText, hint);
    const text = subSection || sectionText;
    const items: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed)) {
        items.push(trimmed.replace(/^[-*\d.)\s]+/, '').trim());
      }
    }
    return items.filter(Boolean);
  }

  /**
   * Extract a section from arbitrary text (not the full document).
   */
  private extractSectionFromText(text: string, heading: string): string | null {
    const pattern = new RegExp(`^#{1,4}\\s+.*${heading}.*$`, 'm');
    const match = text.match(pattern);
    if (!match || match.index === undefined) return null;

    const startIdx = match.index + match[0].length;
    const rest = text.substring(startIdx);
    const nextHeading = rest.match(/^#{1,4}\s+/m);
    const endIdx = nextHeading ? nextHeading.index! : rest.length;

    return rest.substring(0, endIdx).trim();
  }

  private normalizeArtifactType(fileName: string): string {
    if (/^sprint_contract_.+\.md$/i.test(fileName)) return 'sprint_contract';
    if (/^review_report_.+\.md$/i.test(fileName)) return 'review_report';
    return fileName;
  }
}
