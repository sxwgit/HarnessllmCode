import { Logger } from '../logger/index.js';

export interface AdaptiveThresholds {
  maxSprintIterations: number;
  maxRollbacks: number;
  maxNegotiationRounds: number;
  evaluationTimeout: number;
}

const THRESHOLD_TABLE: Record<string, AdaptiveThresholds> = {
  simple:   { maxSprintIterations: 2, maxRollbacks: 1, maxNegotiationRounds: 2, evaluationTimeout: 120_000 },
  medium:   { maxSprintIterations: 3, maxRollbacks: 2, maxNegotiationRounds: 3, evaluationTimeout: 180_000 },
  complex:  { maxSprintIterations: 4, maxRollbacks: 2, maxNegotiationRounds: 4, evaluationTimeout: 300_000 },
};

/**
 * Adjust thresholds based on Sprint estimated effort (1-10 scale)
 * Per framework spec section 7.3
 */
export function getAdaptiveThresholds(
  effortScore: number,
  logger?: Logger,
): AdaptiveThresholds {
  let tier: string;
  if (effortScore <= 3) {
    tier = 'simple';
  } else if (effortScore <= 7) {
    tier = 'medium';
  } else {
    tier = 'complex';
  }

  const thresholds = THRESHOLD_TABLE[tier];
  logger?.info('Adaptive thresholds selected', { effortScore, tier, thresholds });
  return { ...thresholds };
}

/**
 * Parse effort score from a sprint plan document section
 */
export function parseEffortScore(sprintSection: string): number {
  const patterns = [
    /工作量[：:]\s*(\d+)/,
    /effort[：:]\s*(\d+)/i,
    /预估.*?(\d+)[分点]/,
    /复杂度[：:]\s*(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = sprintSection.match(pattern);
    if (match) {
      const score = parseInt(match[1]);
      return Math.min(10, Math.max(1, score));
    }
  }

  // Default: medium complexity
  return 5;
}
