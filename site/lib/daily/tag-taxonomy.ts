// ============================================================================
// the dAIly — Tag Taxonomy
// ============================================================================
// Fixed per-category tag set used by the tagged memory system. When a
// cast member's response is persisted to forum_utterances, an LLM call
// assigns 1-3 tags from the appropriate category's taxonomy. The same
// taxonomy is used at query time to retrieve relevant past statements.
//
// IMPORTANT: tags must be STABLE across sessions. If a tag changes name
// or splits, the historical memory query won't match. Add new tags
// freely; rename tags only with intent and a migration plan.
//
// New categories add their own tag list. Tags should be:
// - Specific enough to distinguish meaningful topics
// - Broad enough that 1-3 tags cover most utterances
// - Stable in name (don't rename casually)
// - Lowercase, kebab-case, no spaces
// ============================================================================

export const TAG_TAXONOMIES: Record<string, string[]> = {
  ai: [
    'safety',
    'alignment',
    'agentic-tools',
    'model-release',
    'interpretability',
    'compute-infrastructure',
    'regulation',
    'child-safety',
    'commerce',
    'pricing',
    'evaluation-methodology',
    'scheming',
    'open-weights',
    'multimodality',
    'coding-agents',
    'jailbreaking',
    'training-data',
    'rlhf',
    'benchmarks',
    'agi-discourse',
    'lab-collaboration',
    'philanthropy',
    'deepfakes',
    'media-generation',
    'governance',
  ],
  // Future categories add their own tag lists here.
  // science: [...],
  // tech: [...],
};

/** Get the tag list for a category. Throws if the category is unknown
 *  — taxonomies must be defined explicitly per category, not derived. */
export function getTaxonomy(category: string): string[] {
  const tags = TAG_TAXONOMIES[category];
  if (!tags) {
    throw new Error(`No tag taxonomy defined for category: ${category}`);
  }
  return tags;
}

/** Validate that a set of proposed tags are all valid for the category.
 *  Returns the subset that's valid (silently dropping unknown tags). */
export function filterValidTags(category: string, proposedTags: string[]): string[] {
  const valid = new Set(getTaxonomy(category));
  return proposedTags.filter(t => valid.has(t));
}
