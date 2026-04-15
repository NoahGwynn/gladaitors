// ============================================================================
// the dAIly — Stage 5b: Cast Selection
// ============================================================================
// Two flavours, picked by /api/daily/cron/prepare based on whether Stage 4
// produced a moderator or dropped to the unmoderated format:
//
//   selectCast (MODERATED PATH)
//     The moderator picks the cast for today's session, informed by
//     the light research from Stage 5a and the pool's stances +
//     conflict picture from the FOCUSED broadcast (Stage 4b).
//
//   selectUnmoderatedCast (UNMODERATED PATH)
//     No moderator — purely rule-based. Sorts the pool by focused-
//     broadcast conflict score DESC, takes the top 3. The reasoning
//     here is philosophically different from the moderated case: when
//     no model is clean enough to chair, the most honest response is
//     to put the most-invested voices (highest conflict = biggest
//     stake) in the ring. "Nobody is neutral, so let the stakeholders
//     argue." Self-vetoed models are still eligible as panelists —
//     self-veto specifically disclaims the MODERATOR chair, not
//     panelist participation.
//
// Rules for the moderated path (locked with the user):
//
// SESSION TYPE
// - debate         — there are genuinely opposing stances among the pool
// - fireside_chat  — ALL pool members essentially agree on the topic
//
// CAST PICKING (debate)
// - Seat 1: model with the highest stake (highest conflict score) — they
//   have the most to say and the most at risk in how the story is framed
// - Seat 2: model whose stance most directly opposes seat 1
// - Seat 3 (optional): model with a genuinely DIFFERENT framing/angle
//
// CAST PICKING (fireside chat)
// - All stances align, so the moderator picks 2-3 of the most interesting
//   aligned voices to probe and pressure-test the consensus.
//
// EXCLUSIONS
// - The moderator excludes themselves (moderators don't participate).
// - Models that errored in the focused broadcast are excluded.
//
// PUBLISHED OUTPUT
// - Cast picks with per-seat reasoning (published in the journey)
// - Session type label
// - "Also invited" section: every pool member who wasn't cast
// ============================================================================

import { callPoolModel, type PoolModel, MODEL_POOL } from './model-pool';
import { buildIdentityAnchor } from './broadcast';
import type { FocusedBroadcastResult } from './focused-broadcast';
import type { RotationEntry } from './moderator-selection';
import type { ResearchResult } from './research';

// --- Types ---

export interface CastParticipant {
  modelId: string;
  modelName: string;
  provider: string;
  region: string;
  seat: number;            // 1, 2, or 3
  stance: string;          // from focused broadcast
  conflictScore: number;   // from focused broadcast
  conflictReason: string;  // from focused broadcast
  /** True if this panelist self-vetoed the MODERATOR role. They can
   *  still participate as a panelist — self-veto is role-scoped. The
   *  UI surfaces the reason next to their seat for transparency. */
  unfitToModerate?: boolean;
  unfitReason?: string;
  /** The moderator's stated reason for picking this seat, OR the
   *  rule-based reason if this is an unmoderated cast (e.g.
   *  "Highest focused conflict score at 85 — biggest stake in topic") */
  reasoning: string;
}

export interface AlsoInvitedEntry {
  modelId: string;
  modelName: string;
  provider: string;
  stance: string;
  conflictScore: number;
  /** Legacy field — pool votes happen in the initial broadcast which
   *  no longer collects stance/conflict, so vote rank is no longer
   *  correlated with cast selection. Kept nullable for compat with
   *  existing session rows and for the journey UI. */
  voteRank?: number | null;
  considered: boolean;
}

export interface CastSelectionResult {
  sessionType: 'debate' | 'fireside_chat';
  participants: CastParticipant[];
  /** The moderator's overall justification for the cast composition,
   *  OR the rule-based reasoning if this is an unmoderated cast. */
  moderatorReasoning: string;
  /** Pool members not picked, with their declared positions */
  alsoInvited: AlsoInvitedEntry[];
  error?: string;
}

// --- Build the cast prompt (moderated path) ---

function buildCastPrompt(
  topicTitle: string,
  topicSignificance: string[],
  research: ResearchResult,
  candidates: Array<{
    model: PoolModel;
    stance: string;
    conflictScore: number;
    conflictReason: string;
  }>,
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly session in the ${category.toUpperCase()} category. You've researched the topic and now you need to pick the cast — the participants who will join you in the session.

You are NOT a participant. You facilitate. You pick 2 or 3 cast members from the pool and decide what KIND of session today will be.

THE TWO SESSION TYPES:
1. DEBATE — there are genuinely opposing stances among the pool. The cast members argue different positions and you press them on each other's claims.
2. FIRESIDE_CHAT — ALL pool members essentially agree on the topic. There's no opposition to debate, so the format becomes you probing and pressure-testing the shared consensus with a small group of the most interesting aligned voices.

DECIDING THE TYPE:
Read every stance carefully. If you find genuine disagreement — even between just two models — it's a DEBATE. If everyone is essentially aligned (different framings of the same conclusion), it's a FIRESIDE_CHAT. Don't force-fit either way. If two models oppose and seven agree, it's still a debate — there are opposing stances.

PICKING THE CAST FOR A DEBATE:
- Seat 1: the model with the highest stake (highest conflict score on this topic) — they have the most to say and the most at risk in how the story is framed.
- Seat 2: the model whose stance most directly opposes seat 1 — the counterweight.
- Seat 3 (OPTIONAL): a model with a genuinely DIFFERENT framing or angle. Not just another opinion in a similar register, but a genuinely different way of approaching the question. Pick a third seat ONLY if it adds a unique angle. If the third would just repeat one of the first two, run the debate two-handed. Two-handed is a valid choice, not a fallback.

PICKING THE CAST FOR A FIRESIDE CHAT:
- All stances are aligned, so you're not picking for opposition. You're picking 2-3 of the most interesting voices to interrogate the consensus together.
- Favour models with high stake, distinctive framing, or detailed reasoning.
- Pick 2 or 3 based on whether a third adds genuine variety in HOW they're aligned (not in WHAT they're aligned on).

YOUR JOB IS EDITORIAL JUDGMENT, not algorithm-following. Justify every pick. Your reasoning will be published alongside the session record so the audience can see exactly why you assembled this cast.`;

  // Render the research notes
  const researchBlock = [
    research.overallSummary ? `OVERALL: ${research.overallSummary}` : '',
    research.synthesisedFacts.length > 0 ? `SYNTHESISED FACTS:\n${research.synthesisedFacts.map(f => `  - ${f}`).join('\n')}` : '',
    research.contestedClaims.length > 0 ? `CONTESTED CLAIMS:\n${research.contestedClaims.map(c => `  - ${c}`).join('\n')}` : '',
    research.openQuestions.length > 0 ? `OPEN QUESTIONS:\n${research.openQuestions.map(q => `  - ${q}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  // Render the candidate pool
  const candidateBlocks = candidates.map(c => {
    const lines = [
      `MODEL_ID: ${c.model.id}`,
      `  Provider: ${c.model.provider} (${c.model.family})`,
      `  Region: ${c.model.region}`,
      `  Conflict score on this topic: ${c.conflictScore}/100`,
      `  Conflict reason: ${c.conflictReason || '(none stated)'}`,
      `  Stance: ${c.stance}`,
    ];
    return lines.join('\n');
  }).join('\n\n');

  const user = `THE TOPIC:
  ${topicTitle}
${topicSignificance.length > 0 ? `  Significance: ${topicSignificance.join(' | ')}` : ''}

YOUR RESEARCH NOTES (from your earlier reading of the source material):

${researchBlock || '(no research notes available)'}

CANDIDATE POOL (you — the moderator — are excluded; you don't participate):

${candidateBlocks}

YOUR TASK:

1. Read every stance.
2. Decide the SESSION TYPE — debate (any opposing stances) or fireside_chat (all aligned).
3. Pick 2 or 3 cast members following the rules above.
4. Justify every pick in 1-2 sentences (this gets published).
5. Write a 3-5 sentence overall reasoning explaining the cast composition: why this session type, why these models, and how the cast serves the discussion.

Be honest. If you can't find genuine opposition, call it a fireside chat. If a third unique angle doesn't exist, run the debate two-handed. Don't pad the cast for the sake of three seats.

Respond with JSON only. Use exact MODEL_ID values from the candidates above.

{
  "sessionType": "debate" | "fireside_chat",
  "participants": [
    {
      "modelId": "<exact model id>",
      "seat": 1,
      "reasoning": "<why this model in this seat>"
    },
    {
      "modelId": "<exact model id>",
      "seat": 2,
      "reasoning": "<why this model in this seat>"
    }
  ],
  "overallReasoning": "<3-5 sentences explaining the cast composition>"
}`;

  return { system, user };
}

// --- Parse the cast response ---

function parseCastResponse(raw: string): {
  sessionType: 'debate' | 'fireside_chat' | null;
  participants: Array<{ modelId: string; seat: number; reasoning: string }>;
  overallReasoning: string;
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

    const sessionType = parsed.sessionType === 'debate' || parsed.sessionType === 'fireside_chat'
      ? parsed.sessionType
      : null;

    const rawParticipants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const participants = (rawParticipants as Array<Record<string, unknown>>).map(p => ({
      modelId: typeof p.modelId === 'string' ? p.modelId : '',
      seat: typeof p.seat === 'number' ? p.seat : 0,
      reasoning: typeof p.reasoning === 'string' ? p.reasoning : '',
    })).filter(p => p.modelId && p.seat > 0);

    const overallReasoning = typeof parsed.overallReasoning === 'string'
      ? parsed.overallReasoning
      : '';

    return { sessionType, participants, overallReasoning };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Moderated cast selection (Stage 5b, moderated path) ---

/** Run moderated cast selection: the moderator picks 2-3 cast members
 *  and the session type, informed by the research from Stage 5a and
 *  the pool's stances from the focused broadcast (Stage 4b). */
export async function selectCast(
  topicTitle: string,
  topicSignificance: string[],
  research: ResearchResult,
  moderatorModel: PoolModel,
  focusedBroadcast: FocusedBroadcastResult,
  category: string,
): Promise<CastSelectionResult> {
  // Build the candidate pool from focused broadcast responses:
  // every model that responded successfully, EXCLUDING the moderator
  // (moderators don't participate) and any model that errored.
  const candidates = focusedBroadcast.responses
    .filter(r => !r.error && r.modelId !== moderatorModel.id && r.stance)
    .map(r => {
      const poolModel = MODEL_POOL.find(m => m.id === r.modelId);
      return {
        model: poolModel!,
        stance: r.stance,
        conflictScore: r.conflictScore,
        conflictReason: r.conflictReason,
        unfitToModerate: r.unfitToModerate,
        unfitReason: r.unfitReason,
      };
    })
    .filter(c => c.model);

  if (candidates.length < 2) {
    return {
      sessionType: 'fireside_chat',
      participants: [],
      moderatorReasoning: '',
      alsoInvited: [],
      error: `Insufficient candidates (${candidates.length}) — need at least 2 to assemble a cast`,
    };
  }

  console.log(`[CAST] Moderator ${moderatorModel.displayName} picking from ${candidates.length} candidates`);

  const { system, user } = buildCastPrompt(
    topicTitle,
    topicSignificance,
    research,
    candidates,
    category,
    moderatorModel,
  );

  let raw: string;
  try {
    raw = await callPoolModel(moderatorModel, system, user, 8000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[CAST] ${moderatorModel.displayName} call failed: ${msg}`);
    return {
      sessionType: 'fireside_chat',
      participants: [],
      moderatorReasoning: '',
      alsoInvited: [],
      error: msg,
    };
  }

  const parsed = parseCastResponse(raw);
  if ('error' in parsed) {
    console.error(`[CAST] Parse failed: ${parsed.error}`);
    return {
      sessionType: 'fireside_chat',
      participants: [],
      moderatorReasoning: '',
      alsoInvited: [],
      error: `Failed to parse moderator response: ${parsed.error}`,
    };
  }

  if (!parsed.sessionType) {
    return {
      sessionType: 'fireside_chat',
      participants: [],
      moderatorReasoning: parsed.overallReasoning,
      alsoInvited: [],
      error: 'Moderator did not return a valid sessionType',
    };
  }

  const participants: CastParticipant[] = [];
  const pickedModelIds = new Set<string>();

  for (const pick of parsed.participants) {
    const candidate = candidates.find(c => c.model.id === pick.modelId);
    if (!candidate) {
      console.warn(`[CAST] Moderator picked unknown model: ${pick.modelId} — dropping`);
      continue;
    }
    if (pickedModelIds.has(pick.modelId)) {
      console.warn(`[CAST] Moderator picked ${pick.modelId} twice — dropping duplicate`);
      continue;
    }
    pickedModelIds.add(pick.modelId);
    participants.push({
      modelId: candidate.model.id,
      modelName: candidate.model.displayName,
      provider: candidate.model.provider,
      region: candidate.model.region,
      seat: pick.seat,
      stance: candidate.stance,
      conflictScore: candidate.conflictScore,
      conflictReason: candidate.conflictReason,
      unfitToModerate: candidate.unfitToModerate,
      unfitReason: candidate.unfitReason,
      reasoning: pick.reasoning,
    });
  }

  participants.sort((a, b) => a.seat - b.seat);

  const alsoInvited: AlsoInvitedEntry[] = candidates
    .filter(c => !pickedModelIds.has(c.model.id))
    .map(c => ({
      modelId: c.model.id,
      modelName: c.model.displayName,
      provider: c.model.provider,
      stance: c.stance,
      conflictScore: c.conflictScore,
      considered: true,
    }));

  console.log(`[CAST] ${moderatorModel.displayName} picked ${parsed.sessionType} with ${participants.length} seats; ${alsoInvited.length} also invited`);

  return {
    sessionType: parsed.sessionType,
    participants,
    moderatorReasoning: parsed.overallReasoning,
    alsoInvited,
  };
}

// --- Unmoderated cast selection (Stage 5b, unmoderated path) ---

/** Rule-based cast selection for the unmoderated debate format. Used
 *  when Stage 4 moderator selection returned a drop-to-unmoderated
 *  outcome (every candidate scored ≥80 conflict OR every candidate
 *  self-vetoed).
 *
 *  Rule: sort pool by focused-broadcast conflict score DESC, take
 *  top 3. Tiebreakers:
 *    1. Non-vetoed before vetoed (a model willing to chair is a
 *       stronger panelist than one that ducked out)
 *    2. Rotation order from `rotationQueue` (earliest first)
 *    3. Stable pool order
 *
 *  Self-vetoed models are still eligible as panelists — self-veto is
 *  specifically about the moderator role, not about having a voice.
 *  Their self-veto reason is surfaced in the UI next to their seat.
 *
 *  Hard-fails at fewer than 2 valid responses. */
export function selectUnmoderatedCast(
  focusedBroadcast: FocusedBroadcastResult,
  rotationQueue: RotationEntry[],
  maxCastSize: number = 3,
): CastSelectionResult {
  const rotationOrder = new Map<string, number>();
  rotationQueue.forEach((entry, i) => rotationOrder.set(entry.model.id, i));

  const valid = focusedBroadcast.responses
    .filter(r => !r.error && r.stance);

  if (valid.length < 2) {
    return {
      sessionType: 'debate',
      participants: [],
      moderatorReasoning: '',
      alsoInvited: [],
      error: `Unmoderated fallback requires at least 2 valid focused-broadcast responses — got ${valid.length}`,
    };
  }

  // Sort by conflict DESC with tiebreakers
  const sorted = [...valid].sort((a, b) => {
    // Primary: conflict DESC (highest stake first)
    if (a.conflictScore !== b.conflictScore) return b.conflictScore - a.conflictScore;
    // Tie 1: non-vetoed beats vetoed
    if (a.unfitToModerate !== b.unfitToModerate) return a.unfitToModerate ? 1 : -1;
    // Tie 2: rotation order (earliest first)
    const ra = rotationOrder.get(a.modelId) ?? 999;
    const rb = rotationOrder.get(b.modelId) ?? 999;
    if (ra !== rb) return ra - rb;
    // Tie 3: pool order
    const pa = MODEL_POOL.findIndex(m => m.id === a.modelId);
    const pb = MODEL_POOL.findIndex(m => m.id === b.modelId);
    return pa - pb;
  });

  const picked = sorted.slice(0, maxCastSize);
  const pickedIds = new Set(picked.map(p => p.modelId));

  const participants: CastParticipant[] = picked.map((r, i) => {
    const poolModel = MODEL_POOL.find(m => m.id === r.modelId)!;
    return {
      modelId: r.modelId,
      modelName: r.modelName,
      provider: r.provider,
      region: r.region,
      seat: i + 1,
      stance: r.stance,
      conflictScore: r.conflictScore,
      conflictReason: r.conflictReason,
      unfitToModerate: r.unfitToModerate,
      unfitReason: r.unfitReason,
      reasoning: `Selected automatically: focused conflict ${r.conflictScore}/100${
        r.unfitToModerate ? ` (self-vetoed the moderator role — kept as panelist stakeholder)` : ''
      }. Highest-stake voices are seated when no model is clean enough to chair.`,
    };
  });

  const alsoInvited: AlsoInvitedEntry[] = valid
    .filter(r => !pickedIds.has(r.modelId))
    .map(r => ({
      modelId: r.modelId,
      modelName: r.modelName,
      provider: r.provider,
      stance: r.stance,
      conflictScore: r.conflictScore,
      considered: true,
    }));

  const reasoning = `No model in the pool could moderate today's topic — every candidate either scored ≥80 conflict or self-vetoed the moderator role. The session runs in unmoderated format instead, with the ${participants.length} highest-stake voices seated as panelists. Each panelist's conflict reason is published next to their name.`;

  console.log(`[CAST-UNMODERATED] Seated ${participants.length} panelists by conflict DESC: ${participants.map(p => `${p.modelName}(${p.conflictScore})`).join(', ')}`);

  return {
    sessionType: 'debate',
    participants,
    moderatorReasoning: reasoning,
    alsoInvited,
  };
}
