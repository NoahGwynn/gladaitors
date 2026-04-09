// ============================================================================
// Site configuration — feature flags and constants
// ============================================================================

export const config = {
  /** Show the series/episodes section of the site. Disable before episodes are ready. */
  seriesEnabled: false,

  /** Show vote counts and view counts publicly (explore feed cards, voting panel
   *  results bar chart). Hide until traffic is meaningful — empty metrics
   *  ("0 votes · 1 view") read as anti-social-proof. Flip to true once the
   *  feed has enough activity that the numbers feel like community signal.
   *  When false:
   *    - Explore cards hide vote/view counts (keep argument count + age)
   *    - Voting panel shows "Thanks for voting" instead of bar chart after voting
   */
  showSocialMetrics: false,

  /** Starting token balance for new users */
  startingTokens: 20,

  /** Max character limits */
  maxTopicLength: 200,
  maxPositionLength: 100,
  maxContextLength: 300,
};
