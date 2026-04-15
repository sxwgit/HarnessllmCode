/**
 * Text normalization utilities for robust keyword matching against LLM output.
 *
 * LLM-generated Markdown can vary in whitespace, fullwidth/halfwidth characters,
 * and case — these utilities normalize text before comparison so that semantically
 * equivalent content is treated as matching.
 */

/**
 * Normalize text for robust keyword matching.
 *
 * Transformations applied in order:
 * 1. Unicode NFKC normalization (fullwidth → halfwidth, compatibility decomposition)
 * 2. Collapse all whitespace (spaces, tabs, newlines, non-breaking spaces) to empty string
 * 3. Optionally lowercase for case-insensitive matching
 */
export function normalizeText(input: string, options?: { caseInsensitive?: boolean }): string {
  let result = input.normalize('NFKC');
  // Collapse all whitespace characters (including \u00A0 non-breaking space) to empty string
  result = result.replace(/[\s\u00A0]+/g, '');
  if (options?.caseInsensitive) {
    result = result.toLowerCase();
  }
  return result;
}

/**
 * Check whether `haystack` (after normalization) contains `needle` (after normalization).
 *
 * By default performs exact substring match on normalized text.
 * With `caseInsensitive: true`, both sides are lowercased after normalization.
 */
export function normalizedIncludes(
  haystack: string,
  needle: string,
  caseInsensitive = false,
): boolean {
  const normalizedHaystack = normalizeText(haystack, { caseInsensitive });
  const normalizedNeedle = normalizeText(needle, { caseInsensitive });
  if (normalizedNeedle === '') return true;
  return normalizedHaystack.includes(normalizedNeedle);
}

/**
 * Extract the first ```json code block from content and parse it as an object.
 * Returns null if no valid JSON block is found.
 *
 * This is the canonical JSON extraction method shared across the framework.
 */
export function extractJsonBlock(content: string): Record<string, unknown> | null {
  const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON — fall through
    }
  }
  return null;
}
