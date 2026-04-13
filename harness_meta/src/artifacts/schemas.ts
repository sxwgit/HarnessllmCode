import { z } from 'zod';

// ============ Standard Requirement ============
export const StandardRequirementSchema = z.object({
  projectName: z.string(),
  overview: z.string(),
  coreFeatures: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    priority: z.enum(['P0', 'P1', 'P2']),
  })),
  techStack: z.object({
    runtime: z.string(),
    language: z.string(),
    frameworks: z.array(z.string()),
    dependencies: z.array(z.string()),
  }),
  constraints: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
});

// ============ Product Spec ============
export const ProductSpecSchema = z.object({
  overview: z.string(),
  targetUsers: z.string(),
  coreValue: z.string(),
  features: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    priority: z.string(),
    dependencies: z.array(z.string()).optional(),
  })),
  userStories: z.array(z.object({
    story: z.string(),
    acceptanceCriteria: z.array(z.string()),
  })),
  nonFunctionalRequirements: z.object({
    performance: z.string(),
    compatibility: z.string(),
    maintainability: z.string(),
    security: z.string(),
  }),
  boundaries: z.object({
    inScope: z.array(z.string()),
    outOfScope: z.array(z.string()),
    futureScope: z.array(z.string()),
  }),
});

// ============ Architecture Design ============
export const ArchitectureDesignSchema = z.object({
  overallArchitecture: z.string(),
  layers: z.array(z.object({
    name: z.string(),
    responsibility: z.string(),
    components: z.array(z.string()),
  })),
  coreModules: z.array(z.object({
    name: z.string(),
    responsibility: z.string(),
    interfaces: z.array(z.string()),
    dependencies: z.array(z.string()),
  })),
  dataModels: z.array(z.object({
    name: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      description: z.string(),
    })),
  })),
  techStack: z.object({
    runtime: z.string(),
    language: z.string(),
    frameworks: z.record(z.string()),
    devTools: z.array(z.string()),
  }),
});

// ============ Sprint Plan ============
export const SprintPlanSchema = z.object({
  sprints: z.array(z.object({
    id: z.string(),
    name: z.string(),
    priority: z.number(),
    goals: z.array(z.string()),
    deliverables: z.array(z.string()),
    estimatedEffort: z.number().min(1).max(10),
    dependencies: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
  })),
  milestones: z.array(z.object({
    name: z.string(),
    tag: z.string(),
    sprints: z.array(z.string()),
  })),
});

// ============ Sprint Contract ============
export const SprintContractSchema = z.object({
  sprintId: z.string(),
  goals: z.array(z.string()),
  features: z.array(z.object({
    id: z.string(),
    description: z.string(),
    priority: z.string(),
    deliverables: z.array(z.string()),
  })),
  acceptanceCriteria: z.array(z.string()),
  testCases: z.array(z.object({
    id: z.string(),
    description: z.string(),
    steps: z.array(z.string()),
    expectedResult: z.string(),
  })),
  files: z.array(z.string()),
});

// ============ Review Report ============
export const ReviewReportSchema = z.object({
  sprintId: z.string(),
  passed: z.boolean(),
  scores: z.array(z.object({
    dimension: z.string(),
    weight: z.number(),
    score: z.number(),
    maxScore: z.number(),
    notes: z.string(),
  })),
  weightedAverage: z.number(),
  issues: z.array(z.object({
    id: z.string(),
    severity: z.string(),
    file: z.string().optional(),
    line: z.number().optional(),
    description: z.string(),
    rootCause: z.string(),
    fixSuggestion: z.string(),
  })),
});

// ============ Type exports ============
export type StandardRequirement = z.infer<typeof StandardRequirementSchema>;
export type ProductSpec = z.infer<typeof ProductSpecSchema>;
export type ArchitectureDesign = z.infer<typeof ArchitectureDesignSchema>;
export type SprintPlan = z.infer<typeof SprintPlanSchema>;
export type SprintContract = z.infer<typeof SprintContractSchema>;
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
