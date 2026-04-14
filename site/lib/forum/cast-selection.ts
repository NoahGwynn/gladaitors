// ============================================================================
// dAIly Forum — Stage 5b: Cast Selection
// ============================================================================
// The moderator picks the cast for today's session, informed by the
// light research from Stage 5a and the pool's stances/conflicts from
// Stage 3.
//
// Rules (locked with the user):
//
// SESSION TYPE
// - debate         — there are genuinely opposing stances among the pool
// - fireside_chat  — ALL pool members essentially agree on the topic
//
// The moderator decides which type by reading every stance.
//
// CAST PICKING (debate)
// - Seat 1: model with the highest stake (highest conflict score) — they
//   have the most to say and the most at risk in how the story is framed
// - Seat 2: model whose stance most directly opposes seat 1
// - Seat 3 (optional): model with a genuinely DIFFERENT framing/angle —
//   not just another opinion. Only picked if it adds a unique angle.
//   Two-handed debate is a valid choice, not a fallback.
//
// CAST PICKING (fireside chat)
// - All stances align, so the moderator picks 2-3 of the most interesting
//   aligned voices to probe and pressure-test the consensus.
// - Favour high stake, distinctive framing, detailed reasoning.
//
// EXCLUSIONS
// - The moderator excludes themselves (moderators don't participate).
// - Models that errored in the broadcast are excluded (no stance on file).
//
// PUBLISHED OUTPUT
// - Cast picks with per-seat reasoning (published in the journey)
// - Session type label
// - "Also invited" section: every pool member who wasn't cast, with their
//   stance/conflict/vote — published as part of the session record so the
//   audience can see who was considered
// ============================================================================

import { callPoolModel, type PoolModel, MODEL_POOL } from './model-pool';
import { buildIdentityAnchor, type BroadcastResult } from './broadcast';
import type { ResearchResult } from './research';

// --- Types ---

export interface CastParticipant {
  modelId: string;
  modelName: string;
  provider: string;
  region: string;
  seat: number;            // 1, 2, or 3
  stance: string;          // from broadcast snapshot
  conflictScore: number;   // from broadcast snapshot
  conflictReason: string;  // from broadcast snapshot
  /** The moderator's stated reason for picking this seat */
  reasoning: string;
}

export interface AlsoInvitedEntry {
  modelId: string;
  modelName: string;
  provider: string;
  stance: string;
  conflictScore: number;
  voteRank: number | null;
  /** Whether the moderator can be inferred to have implicitly considered
   *  and skipped this model. Always true for now — every uncast model
   *  was "considered". */
  considered: boolean;
}

export interface CastSelectionResult {
  sessionType: 'debate' | 'fireside_chat';
  participants: CastParticipant[];
  /** The moderator's overall justification for the cast composition */
  moderatorReasoning: string;
  /** Pool members not picked, with their declared positions */
  alsoInvited: AlsoInvitedEntry[];
  error?: string;
}

// --- Build the cast prompt ---

function buildCastPrompt(
  topicTitle: string,
  topicSignificance: string[],
  research: ResearchResult,
  candidates: Array<{
    model: PoolModel;
    stance: string;
    conflictScore: number;
    conflictReason: string;
    voteRank: number | null;
  }>,
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly Forum session in the ${category.toUpperCase()} category. You've researched the topic and now you need to pick the cast — the participants who will join you in the session.

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
      `  Vote rank (where they ranked this topic in round 1): ${c.voteRank ?? '(unranked)'}`,
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

// --- Main entry point ---

/** Run cast selection: the moderator picks 2-3 cast members and the
 *  session type, informed by the research from Stage 5a and the
 *  pool's stances from Stage 3. */
export async function selectCast(
  topicTitle: string,
  topicSignificance: string[],
  research: ResearchResult,
  moderatorModel: PoolModel,
  broadcast: BroadcastResult,
  topicId: string,
  category: string,
): Promise<CastSelectionResult> {
  // Build the candidate pool: every model that responded successfully
  // to the broadcast, EXCLUDING the moderator (moderators don't
  // participate) and any model that errored.
  const candidates = broadcast.responses
    .filter(r => !r.error && r.modelId !== moderatorModel.id)
    .map(r => {
      const poolModel = MODEL_POOL.find(m => m.id === r.modelId);
      const stance = r.stances.find(s => s.threadId === topicId)?.stance || '';
      const conflict = r.conflicts.find(c => c.threadId === topicId);
      const vote = r.votes.find(v => v.threadId === topicId);
      return {
        model: poolModel!,
        stance,
        conflictScore: conflict?.conflictScore || 0,
        conflictReason: conflict?.conflictReason || '',
        voteRank: vote?.rank ?? null,
      };
    })
    .filter(c => c.model && c.stance); // must have model entry + stance text

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
    // 8000 tokens — Gemini 2.5 Pro's thinking mode consumes internal
    // tokens from this budget. 3000 was tight when Gemini moderates.
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

  // Build the participants array by joining moderator picks with
  // candidate data. Drop any picks that don't match a candidate
  // (defensive — shouldn't happen but handles model hallucinations).
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
      reasoning: pick.reasoning,
    });
  }

  // Sort participants by seat number (1, 2, 3)
  participants.sort((a, b) => a.seat - b.seat);

  // Build "also invited" — every candidate that wasn't picked
  const alsoInvited: AlsoInvitedEntry[] = candidates
    .filter(c => !pickedModelIds.has(c.model.id))
    .map(c => ({
      modelId: c.model.id,
      modelName: c.model.displayName,
      provider: c.model.provider,
      stance: c.stance,
      conflictScore: c.conflictScore,
      voteRank: c.voteRank,
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
