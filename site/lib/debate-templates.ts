// ============================================================================
// Debate Templates — v3 utility pivot
// ============================================================================
// Pre-built debate configurations for the use cases the Notion pivot
// doc calls out. Each template pre-fills the topic framing, position
// prompts for each side, and context hints. Selecting a template on
// the /journal/debate form populates the form; the user can still
// edit before clicking Start.
//
// These are the visible product change that signals the utility pivot
// externally: a user who sees "strategy red-team" as a button
// understands what they'd get and why they'd pay for it. A user who
// only sees "start a debate" has to imagine the use case themselves.
//
// Templates aren't restrictive — free-form debates still work. But
// they do conversion work the empty configuration doesn't.
//
// Per Notion's Debate utility pivot page.
// ============================================================================

export interface DebateTemplate {
  /** URL-safe slug — used as the query parameter when linking to the
   *  form with a pre-selected template. */
  slug: string;

  /** Short label shown on the template card */
  name: string;

  /** One-line tagline — the "what this is for" hook */
  tagline: string;

  /** 2-3 sentence description rendered in the template card body */
  description: string;

  /** Emoji shown on the card. Keeping these textual so we don't have
   *  to deal with icon assets in v3. */
  icon: string;

  /** Placeholder text for the topic input when this template is
   *  active. Teaches the user what to type in without being
   *  prescriptive. */
  topicPlaceholder: string;

  /** Position prompts for each debater seat. The form is a 2-debater
   *  template; third-seat templates can be added later. Index 0 = seat 1,
   *  index 1 = seat 2. */
  positions: [string, string];

  /** Prepended to the context input as a starter block. Tells the
   *  debating models what use case the user is running and what kind
   *  of arguments land in this frame. The user sees this in the
   *  context field and can edit it — it's not hidden infrastructure. */
  contextHint: string;

  /** Suggested number of rounds. Deeper templates like strategy
   *  red-team benefit from more rounds; quicker templates like
   *  "argue both sides" can run leaner. */
  suggestedRounds: number;
}

export const DEBATE_TEMPLATES: DebateTemplate[] = [
  {
    slug: 'strategy-red-team',
    name: 'Strategy red-team',
    tagline: "Here's my strategy. Argue why it will fail.",
    description:
      "You lay out a plan. Two models take turns finding the weakest assumptions, the hidden risks, and the scenarios where the whole thing falls apart. You leave with a sharper version of your strategy or a clearer sense of when to abandon it.",
    icon: '🎯',
    topicPlaceholder: 'e.g. We should launch in the UK before expanding to Europe',
    positions: [
      "The strategy is sound — defend its core assumptions and name the conditions under which it succeeds",
      "The strategy is flawed — find the weakest assumptions, the hidden risks, and the scenarios where it fails",
    ],
    contextHint:
      'Describe your strategy in a few sentences. What are you trying to achieve, what are the key moves, and what are you assuming about the market, competitors, or team?',
    suggestedRounds: 5,
  },

  {
    slug: 'product-positioning',
    name: 'Product positioning',
    tagline: 'Should this product target X or Y?',
    description:
      "Two candidate positions for a product, service, or feature. Each model argues for one. You watch the trade-offs surface instead of agonising about them alone, then decide which position to commit to.",
    icon: '🧭',
    topicPlaceholder: 'e.g. Should our CRM target solo founders or 10-person teams?',
    positions: [
      'Argue the case for targeting the first option — who they are, why they need it, how we win them',
      'Argue the case for the second option — who they are, why they need it, how we win them',
    ],
    contextHint:
      "Describe the product briefly and the two positioning options you're considering. What does each option imply about the feature set, pricing, and go-to-market? What's the evidence for each?",
    suggestedRounds: 4,
  },

  {
    slug: 'policy-tradeoff',
    name: 'Policy trade-off',
    tagline: 'Argue the case for and against this policy choice.',
    description:
      "A structured examination of a policy decision you're weighing. One model argues for adoption, another against. The output is a clear picture of what you gain, what you give up, and the conditions under which each side is right.",
    icon: '⚖️',
    topicPlaceholder: 'e.g. Should we require in-office attendance 3 days a week?',
    positions: [
      'Argue for the policy — the benefits, the problem it solves, the conditions under which it works well',
      'Argue against the policy — the costs, the assumptions it makes, the cases where it backfires',
    ],
    contextHint:
      'Describe the policy clearly, who it affects, and the problem it aims to address. What evidence do you have about how it might play out? What similar policies exist elsewhere?',
    suggestedRounds: 4,
  },

  {
    slug: 'hiring-decision',
    name: 'Hiring decision',
    tagline: 'Argue both sides: hire candidate A vs candidate B.',
    description:
      "Two finalists, two models, one decision. Each model takes one candidate and builds the case for hiring them. You see both arguments side by side, hear the implicit trade-offs, and make a better call than you would by re-reading notes alone.",
    icon: '👥',
    topicPlaceholder: 'e.g. Hire Alex (strong execution, less experience) or Sam (experienced, slower ramp)?',
    positions: [
      'Argue the case for the first candidate — their strengths, the risks their profile mitigates, what they unlock for the team',
      'Argue the case for the second candidate — their strengths, what they bring that the first does not, what they unlock',
    ],
    contextHint:
      "Describe the role, what the team needs, and a summary of each candidate's strengths and gaps. Keep identifying details to a minimum — anonymised summaries are fine and more privacy-friendly.",
    suggestedRounds: 4,
  },

  {
    slug: 'argue-both-sides',
    name: 'Argue both sides',
    tagline: "I'm leaning toward X. Argue the strongest case for Y.",
    description:
      "The fastest way to stress-test a decision you've already half-made. Tell the models what you're leaning toward and they build the strongest possible case for the alternative. If you still feel the same way after reading it, commit with confidence.",
    icon: '🤔',
    topicPlaceholder: "e.g. I'm leaning toward building this in-house — argue the case for buying",
    positions: [
      'Argue the strongest case for the option the user is leaning toward',
      'Argue the strongest case for the option the user is NOT leaning toward — steelman the alternative',
    ],
    contextHint:
      "Tell the models what decision you're facing, which option you're leaning toward, and what's pulling you in that direction. Be brief — just enough for the models to understand the shape of the call.",
    suggestedRounds: 3,
  },

  {
    slug: 'investment-decision',
    name: 'Investment decision',
    tagline: 'Argue both sides: do this vs don\'t do this.',
    description:
      "A structured go/no-go analysis for any meaningful investment of time, money, or attention. One model argues for committing, another for walking away. The output helps you see whether the upside you imagine actually holds up under scrutiny.",
    icon: '💰',
    topicPlaceholder: 'e.g. Should we acquire this competitor for £2M?',
    positions: [
      'Argue the case to commit — the upside, the conditions that make it work, the risks that are acceptable',
      'Argue the case to walk away — the downsides, the hidden costs, the signals this is worse than it looks',
    ],
    contextHint:
      "Describe the investment clearly: what you'd be committing (time, money, attention), what you'd get back, what alternatives exist, and what your uncertainty is about. Keep it tight — 3-5 sentences is plenty.",
    suggestedRounds: 4,
  },
];

/** Look up a template by slug. Returns null if the slug doesn't match
 *  a known template. */
export function getTemplateBySlug(slug: string | null | undefined): DebateTemplate | null {
  if (!slug) return null;
  return DEBATE_TEMPLATES.find((t) => t.slug === slug) || null;
}
