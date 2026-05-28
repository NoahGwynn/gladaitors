// ============================================================================
// Site configuration — feature flags and constants
// ============================================================================

export const config = {
  /** TEMP open-access mode. When true, hides all account/login/sign-up UI and
   *  disables every login-gated restriction (round caps, debater count, premium
   *  model gating) AND the server-side token/auth gates in /api/debate, so the
   *  debate feature is fully open to anonymous users with no caps. The per-IP
   *  rate limit is intentionally kept as abuse insurance. Set back to false to
   *  restore accounts, token billing, and limits. */
  openAccess: true,

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

  /** Starting token balance for new signed-up users. The DB-side source of
   *  truth lives in the `signup_starting_tokens()` SQL function in
   *  schema.sql — this constant must be kept in sync if the UI quotes the
   *  number anywhere (e.g. signup CTA copy "Sign up for 50 free tokens"). */
  startingTokens: 50,

  /** Max character limits */
  maxTopicLength: 200,
  maxPositionLength: 100,
  maxContextLength: 300,

  /** ID of the curated sample debate displayed in the debate page's empty
   *  state (the hero). Fetch it on mount, render read-only. Pick a debate
   *  that demonstrates the product well: universally relatable topic,
   *  standard-tier models (so anonymous users see models they can try),
   *  clear positions, decent argument quality.
   *
   *  Set to null to disable the sample debate and fall back to a text-only
   *  hero (headline + starter topic chips, no live debate preview). */
  sampleDebateId: '50925839-5527-4838-ad9d-68a4e43a54a3' as string | null,
};
