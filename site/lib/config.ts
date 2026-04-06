// ============================================================================
// Site configuration — feature flags and constants
// ============================================================================

export const config = {
  /** Show the series/episodes section of the site. Disable before episodes are ready. */
  seriesEnabled: false,

  /** Starting token balance for new users */
  startingTokens: 20,

  /** Token cost per debate by round count */
  debateCost: {
    3: 6,   // 2 or 3 models, 3 rounds
    5: 10,  // 2 or 3 models, 5 rounds
    7: 14,  // 2 or 3 models, 7 rounds
  } as Record<number, number>,

  /** Available AI models for debates */
  debateModels: [
    { id: 'claude', name: 'Claude', provider: 'anthropic' },
    { id: 'gpt4o', name: 'GPT-4o', provider: 'openai' },
    { id: 'gemini', name: 'Gemini', provider: 'google' },
  ],

  /** Max character limits */
  maxTopicLength: 200,
  maxPositionLength: 100,
  maxContextLength: 300,
};
