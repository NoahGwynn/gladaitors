// ============================================================================
// the dAIly — Moderation Pool (Stage 7 screening)
// ============================================================================
// The Shared Moderation Pipeline runs three screening checks on every
// generated debate before publication: defamation, hallucination, and
// tone/bias. Each check uses a model from THIS pool, not the main
// MODEL_POOL used for casting and debating.
//
// Why a separate pool:
// - Screening is a different job from participating. Main-pool models
//   are debate voices; moderation-pool models are editorial checkers.
//   Conflating them means the same model could be drawn as a panelist
//   and as its own screener on the same session, which is circular.
// - The moderation pool uses specific Sonnet-class models chosen for
//   reasoning quality on structured editorial tasks. They don't rotate
//   or get picked via the casting call logic.
// - Keeps the main pool's rotation / conflict / region-softcap logic
//   uncluttered.
//
// v1 uses Claude Sonnet as the primary screening model for all three
// checks. Notion's original spec said "cheap tier" (Haiku / GPT-4o-mini
// / Gemini Flash) but the operator chose Sonnet-level because
// hallucination detection and defamation screening benefit meaningfully
// from mid-tier reasoning, and the per-day cost delta is trivial.
//
// v2 plans: cross-screening with a different provider (GPT-4o or
// Gemini Pro) to reduce single-model blind spots. Not in v1.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';

export interface ModerationModel {
  /** Unique identifier for this moderation model (separate namespace
   *  from MODEL_POOL — never collides with debate pool model ids) */
  id: string;
  /** Human-readable label for logs and the transparency layer */
  displayName: string;
  /** The actual provider API model string */
  modelId: string;
  /** Which provider this model comes from — used by the cross-screen
   *  logic (v2) to ensure checks come from different providers */
  provider: 'Anthropic' | 'OpenAI' | 'Google';
  /** Hard cap on max output tokens per call, per the provider's limits */
  maxOutputTokens: number;
}

/** The moderation pool — single primary entry in v1. */
export const MODERATION_POOL: ModerationModel[] = [
  {
    id: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    modelId: 'claude-sonnet-4-6',
    provider: 'Anthropic',
    maxOutputTokens: 32000,
  },
];

/** The primary screening model. v1 uses this for all three checks
 *  (defamation, hallucination, tone/bias). v2 may rotate or
 *  cross-screen across multiple providers. */
export const PRIMARY_SCREENER: ModerationModel = MODERATION_POOL[0];

/** Call a moderation model with a system + user prompt. Mirrors the
 *  callPoolModel() shape but isolated from the main pool so the two
 *  can't accidentally share state or model ids. Returns the raw text
 *  or throws on failure — callers handle errors per-check. */
export async function callModerationModel(
  model: ModerationModel,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 8000,
): Promise<string> {
  const clampedMaxTokens = Math.min(maxTokens, model.maxOutputTokens);
  if (clampedMaxTokens < maxTokens) {
    console.log(`[MODERATION] ${model.displayName} maxTokens clamped from ${maxTokens} to ${clampedMaxTokens}`);
  }

  if (model.provider === 'Anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(`No ANTHROPIC_API_KEY set — cannot run moderation check with ${model.displayName}`);
    }
    const client = new Anthropic();
    const response = await client.messages.create({
      model: model.modelId,
      max_tokens: clampedMaxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = response.content[0];
    return block?.type === 'text' ? block.text : '';
  }

  // v2 extension point — add OpenAI / Google branches here for
  // cross-screening support.
  throw new Error(`Moderation provider ${model.provider} not implemented in v1`);
}
