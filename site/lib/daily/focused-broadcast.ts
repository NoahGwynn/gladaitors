// ============================================================================
// the dAIly — Stage 4b: Focused Rebroadcast
// ============================================================================
// Runs AFTER topic selection, BEFORE moderator selection. The winning
// topic is sent back to every pool model for a narrower, higher-stakes
// introspection. Each model answers three questions on ONE topic:
//
//   1. CONFLICT SCORE — 0-100, same rubric as the initial broadcast,
//      but restated forcefully with a direct forcing question: "this
//      topic is X, you are Y — does this topic name your lab or your
//      own research?" Self-scoring is more reliable when the model
//      isn't splitting attention across 8 topics.
//
//   2. UNFIT-TO-MODERATE — boolean self-veto, specifically on the
//      MODERATOR role. Asks "would you be the wrong chair for this?"
//      with explicit anti-caution language ("caution is not a valid
//      reason — audiences read vague abstention as dishonest, not
//      responsible"). Hard filter in moderator selection.
//
//   3. STANCE — 1-2 sentences. If they're selected as a panelist,
//      what position would they argue? Unlike the initial broadcast
//      (which asked for stances across 8 hypotheticals), this is a
//      commitment on the actual topic.
//
// Cost: ~N API calls (one per active pool model), each with a small
// prompt and a small response. Cheaper than the initial broadcast.
//
// Design note: the focused broadcast can be enriched with the
// underlying thread items (titles, sources, dates) — the pool never
// sees these in the initial broadcast (only the organizer paragraphs),
// but with one topic and one question we can afford the richer context.
// ============================================================================

import { getAvailablePool, getSkippedModels, callPoolModel, type PoolModel } from './model-pool';
import { buildIdentityAnchor } from './broadcast';

// --- Types ---

export interface FocusedBroadcastItem {
  /** News item title */
  title: string;
  /** ISO date string (may be null if unknown) */
  publishedAt: string | null;
  /** Source name (e.g. "ArXiv", "TechCrunch") */
  sourceName: string;
  /** Short summary of the item if available */
  summary: string | null;
}

export interface FocusedBroadcastResponse {
  modelId: string;
  modelName: string;
  provider: string;
  region: string;

  /** 0-100 refined conflict score on the single topic */
  conflictScore: number;
  /** One-sentence justification for the score */
  conflictReason: string;

  /** True if the model self-vetoes the moderator role for this topic.
   *  Hard filter in moderator-selection — a true here removes the
   *  candidate regardless of conflict score. */
  unfitToModerate: boolean;
  /** Concrete reason if unfitToModerate is true. Must be specific and
   *  falsifiable — caution-based reasons are rejected in the prompt. */
  unfitReason: string;

  /** 1-2 sentence position the model would argue if cast as a panelist */
  stance: string;

  error?: string;
}

export interface FocusedBroadcastResult {
  topicId: string;
  topicTitle: string;
  responses: FocusedBroadcastResponse[];
  skippedModels: { id: string; name: string; reason: string }[];
  errors: string[];
}

// --- Prompt builder ---

function buildFocusedPrompt(
  topicTitle: string,
  topicSignificance: string[],
  topicReadyReasons: string[],
  items: FocusedBroadcastItem[],
  category: string,
  model: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(model)}

You are participating in the the dAIly ${category.toUpperCase()} session pipeline. A topic has been chosen for today's forum from a shortlist you already voted on. Before the moderator is picked and the cast is assembled, every pool model is asked three questions about this one topic.

Your answers go straight into two decisions: whether you can be selected as today's moderator, and whether you're cast as a panelist. They are also PUBLISHED transparently alongside your name and provider — both to the audience on the session page and to future sessions as part of your on-record history. Be honest. The audience is reading.

QUESTION 1 — CONFLICT SCORE (0-100)

Rate your personal conflict of interest on this specific topic. Use the same rubric as the initial broadcast:
  0     = completely neutral, no stake whatsoever
  20-40 = the topic affects the broader frontier AI industry or a competitor, and ${model.provider}'s position is indirectly relevant, but you can discuss it fairly
  50-70 = the topic touches ${model.provider}'s policies, products, or strategic interests directly, but is not literally about you
  80-100 = the topic is directly about ${model.family}, ${model.provider}, or research you or your lab authored, co-authored, or directly participated in

Apply the rubric STRICTLY. If the topic names your lab in its title, body, or research attribution — or if the research being discussed was produced by you or your lab — your score is ≥80 by the rubric, not a judgement call. This is the rule you agreed to when you accepted the ballot. Do not under-score to stay eligible to moderate; that drift is visible in the transparency layer.

QUESTION 2 — UNFIT-TO-MODERATE (boolean)

Independent of your conflict score, answer this: is there anything about this specific topic that would make you the wrong choice for the MODERATOR role?

The moderator's job is to facilitate — create space for the panelists to discuss the topic in their own words. If you can fairly do that, the answer is false. If you cannot, the answer is true.

Be honest and be specific. Your reason will be read by the audience alongside your name.

CAUTION IS NOT A VALID REASON. "I want to be careful" is NOT a valid reason. "I'm uncertain whether I'd be neutral" is NOT a valid reason. A general sense of discomfort is NOT a valid reason. A vague or cautious abstention reads as performative dishonesty — worse for you than taking the chair and refereeing fairly.

The bar is: could a reader, seeing you moderate this specific topic, point at something concrete and say "that model shouldn't have been in that chair"? Valid reasons are specific and falsifiable:
  - You or your lab authored, co-authored, or directly participated in the research being discussed
  - The topic is literally about a product, policy, or incident your provider ships or is responsible for
  - You have a publicly documented position that is incompatible with neutral framing

If you cannot name a concrete, verifiable reason, the answer is \`false\` and you should take the role.

A \`true\` answer removes you from moderator consideration for this topic. You may still be selected as a panelist — panelists are allowed to have stakes. Being honest here is better for the forum than optimising to be picked.

QUESTION 3 — STANCE

If you were selected as a panelist on this topic, what position would you actually argue? One or two sentences. Your genuine first read after considering the material, not a hedged non-answer. If you have already formed a view, state it; if you're uncertain, state where the uncertainty sits and what would change your mind.

OUTPUT

Respond with JSON only:

{
  "conflictScore": 0,
  "conflictReason": "<one sentence justifying the score>",
  "unfitToModerate": false,
  "unfitReason": "<concrete reason if true, empty string if false>",
  "stance": "<1-2 sentences>"
}`;

  const readyBlock = topicReadyReasons.length > 0
    ? `WHY THE ORGANIZERS SHORTLISTED IT:\n${topicReadyReasons.map(r => `  - ${r}`).join('\n')}`
    : '';

  const significanceBlock = topicSignificance.length > 0
    ? `SIGNIFICANCE:\n  ${topicSignificance.join(' | ')}`
    : '';

  const itemsBlock = items.length > 0
    ? `UNDERLYING MATERIAL (${items.length} item${items.length === 1 ? '' : 's'} the thread is built from):\n${items.map((it, i) => {
        const lines = [
          `  [${i + 1}] ${it.title}`,
          `      Source: ${it.sourceName}${it.publishedAt ? `  ·  ${it.publishedAt.split('T')[0]}` : ''}`,
        ];
        if (it.summary) lines.push(`      ${it.summary}`);
        return lines.join('\n');
      }).join('\n')}`
    : `UNDERLYING MATERIAL: (none attached to this thread)`;

  const user = `THE TOPIC:
  Title: ${topicTitle}

${significanceBlock}

${readyBlock}

${itemsBlock}

THREE QUESTIONS — read the topic material carefully, then answer all three in a single JSON object.

Remember the rules in the system prompt. Be honest, be specific, and apply the conflict rubric strictly. Your answers are published.

{
  "conflictScore": <0-100>,
  "conflictReason": "<one sentence>",
  "unfitToModerate": <true|false>,
  "unfitReason": "<concrete reason if true, empty string if false>",
  "stance": "<1-2 sentences>"
}`;

  return { system, user };
}

// --- Parser ---

function parseFocusedResponse(raw: string): {
  conflictScore: number;
  conflictReason: string;
  unfitToModerate: boolean;
  unfitReason: string;
  stance: string;
} | { error: string } {
  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return { error: 'No JSON found' };

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const rawScore = parsed.conflictScore ?? parsed.conflict_score ?? parsed.score;
    const conflictScore = typeof rawScore === 'number'
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : 0;

    const conflictReason = typeof parsed.conflictReason === 'string'
      ? parsed.conflictReason
      : (typeof parsed.conflict_reason === 'string' ? parsed.conflict_reason : '');

    const unfitToModerate = parsed.unfitToModerate === true
      || parsed.unfit_to_moderate === true;

    const unfitReason = typeof parsed.unfitReason === 'string'
      ? parsed.unfitReason
      : (typeof parsed.unfit_reason === 'string' ? parsed.unfit_reason : '');

    const stance = typeof parsed.stance === 'string'
      ? parsed.stance
      : (typeof parsed.position === 'string' ? parsed.position : '');

    return { conflictScore, conflictReason, unfitToModerate, unfitReason, stance };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Main entry point ---

export interface FocusedBroadcastInput {
  topicId: string;
  topicTitle: string;
  topicSignificance: string[];
  topicReadyReasons: string[];
  items: FocusedBroadcastItem[];
  category: string;
}

/** Run the focused rebroadcast: each available pool model is asked
 *  three questions about the single chosen topic. Models without API
 *  keys are skipped. Errors on individual models return an error-
 *  tagged response so the caller can decide how to handle partial
 *  responses. */
export async function runFocusedBroadcast(
  input: FocusedBroadcastInput,
): Promise<FocusedBroadcastResult> {
  const available = getAvailablePool();
  const skipped = getSkippedModels();

  const result: FocusedBroadcastResult = {
    topicId: input.topicId,
    topicTitle: input.topicTitle,
    responses: [],
    skippedModels: skipped.map(m => ({
      id: m.id,
      name: m.displayName,
      reason: `No API key (${m.apiKeyEnv})`,
    })),
    errors: [],
  };

  if (available.length === 0) {
    result.errors.push('No models available — all missing API keys');
    return result;
  }

  console.log(`[FOCUSED] Sending focused rebroadcast for "${input.topicTitle}" to ${available.length} models`);

  const promises = available.map(async (model): Promise<FocusedBroadcastResponse> => {
    console.log(`[FOCUSED] Calling ${model.displayName}...`);

    const { system, user } = buildFocusedPrompt(
      input.topicTitle,
      input.topicSignificance,
      input.topicReadyReasons,
      input.items,
      input.category,
      model,
    );

    try {
      // 6000 tokens — modest input, small JSON output, but Gemini 2.5
      // Pro can consume a few thousand tokens of thinking budget on a
      // well-formed rubric-application task. 6000 gives headroom
      // without being wasteful.
      const raw = await callPoolModel(model, system, user, 6000);
      const parsed = parseFocusedResponse(raw);

      if ('error' in parsed) {
        console.warn(`[FOCUSED] ${model.displayName} parse failed: ${parsed.error}`);
        return {
          modelId: model.id,
          modelName: model.displayName,
          provider: model.provider,
          region: model.region,
          conflictScore: 0,
          conflictReason: '',
          unfitToModerate: false,
          unfitReason: '',
          stance: '',
          error: `Parse failed: ${parsed.error}`,
        };
      }

      console.log(`[FOCUSED] ${model.displayName}: conflict=${parsed.conflictScore}, unfit=${parsed.unfitToModerate}${parsed.unfitToModerate ? ` ("${parsed.unfitReason.slice(0, 60)}...")` : ''}`);

      return {
        modelId: model.id,
        modelName: model.displayName,
        provider: model.provider,
        region: model.region,
        conflictScore: parsed.conflictScore,
        conflictReason: parsed.conflictReason,
        unfitToModerate: parsed.unfitToModerate,
        unfitReason: parsed.unfitReason,
        stance: parsed.stance,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`[FOCUSED] ${model.displayName} failed: ${msg}`);
      return {
        modelId: model.id,
        modelName: model.displayName,
        provider: model.provider,
        region: model.region,
        conflictScore: 0,
        conflictReason: '',
        unfitToModerate: false,
        unfitReason: '',
        stance: '',
        error: msg,
      };
    }
  });

  result.responses = await Promise.all(promises);

  const succeeded = result.responses.filter(r => !r.error).length;
  const selfVetoed = result.responses.filter(r => !r.error && r.unfitToModerate).length;
  const maxConflict = result.responses
    .filter(r => !r.error)
    .reduce((m, r) => Math.max(m, r.conflictScore), 0);
  console.log(`[FOCUSED] Done: ${succeeded} responded, ${selfVetoed} self-vetoed, highest conflict ${maxConflict}`);

  return result;
}
