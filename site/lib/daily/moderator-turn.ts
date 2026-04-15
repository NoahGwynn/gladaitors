// ============================================================================
// the dAIly — Stage 6: Moderator Turn
// ============================================================================
// The moderator picks their next move and speaks. Single LLM call per
// turn with a big, structured prompt:
//
//   - Identity anchor (who they are)
//   - Topic + agenda (the playbook)
//   - Cast summary with declared stances
//   - Current progress (which segments covered, current turn, remaining budget)
//   - Conversation history so far
//   - Available moves (the 8) with descriptions
//   - Pending ad-hoc memory if the last move was a memory_lookup
//   - End-game warning if turn >= 30
//
// Returns JSON: chosenMove, targetSeat, moderatorText, reasoning.
//
// The moderator can pick from eight moves — see README in debate-runtime.ts
// for the full semantics. Each move has specific runtime handling:
//
//   continue_planned       next planned segment, next participant
//   follow_up              dig into the last participant's response
//   counter_with_opponent  ask another seat to respond to a claim
//   surface_memory         use a pre-loaded or ad-hoc memory hit
//   change_direction       pivot to a better tangent
//   pull_back              return to the plan
//   memory_lookup          non-speaking turn — fetch memory for next turn
//   close                  end the session
//
// If turn >= 36, the runtime forces close regardless of what the
// moderator picks — but the moderator is told this explicitly so they
// can plan for a graceful close.
// ============================================================================

import { buildIdentityAnchor } from './broadcast';
import { callPoolModel, type PoolModel } from './model-pool';
import type { Agenda, AgendaSegment } from './agenda';
import type { CastParticipant } from './cast-selection';
import type { MemoryHit } from './memory-query';

// --- Move definitions ---

export type ModeratorMove =
  | 'continue_planned'
  | 'follow_up'
  | 'counter_with_opponent'
  | 'surface_memory'
  | 'change_direction'
  | 'pull_back'
  | 'memory_lookup'
  | 'close';

export const MOVE_DESCRIPTIONS: Record<ModeratorMove, string> = {
  continue_planned: 'Follow the agenda — ask the next planned question to the next planned participant in the current segment.',
  follow_up: 'Dig deeper into what the last participant just said. Press them on a specific claim, ask for clarification, or probe a weakness in their argument.',
  counter_with_opponent: 'Ask a DIFFERENT cast member to respond directly to a point the last participant made. Use this when a claim deserves a counterweight from another voice.',
  surface_memory: 'Bring up a past statement from a cast member\'s history — either contradicting their current position or reinforcing it for consistency. Only use if you have a pre-loaded memory hit or an ad-hoc memory lookup result to draw from.',
  change_direction: 'Pivot to a more productive line of discussion than the agenda planned. Use when the conversation has surfaced something more interesting than what was on the plan.',
  pull_back: 'Cut a tangent that isn\'t going anywhere and return to the agenda. Use when a change_direction move didn\'t pan out or when a follow_up chain has stalled.',
  memory_lookup: 'NON-SPEAKING turn — you don\'t address a participant, you ask the system to fetch memory for something the last participant just said. The memory hits will appear in your next turn\'s context and you can use surface_memory on the turn after.',
  close: 'End the session. Only pick this when coverage is sufficient AND you\'ve given a clear closing frame. If turn is forced closed at 36, pick close and give the best closing you can.',
};

// --- Types ---

/** A simplified turn record the moderator sees as conversation history */
export interface ModeratorHistoryTurn {
  turnIndex: number;
  actor: 'moderator' | 'participant';
  move?: ModeratorMove;
  seat?: number;
  targetSeat?: number;
  text: string;
  segmentName?: string | null;
}

export interface ModeratorTurnState {
  topicTitle: string;
  topicSignificance: string[];
  category: string;
  agenda: Agenda;
  cast: CastParticipant[];
  moderator: PoolModel;
  /** Conversation history so far — all speaking turns (excluding memory_lookup) */
  history: ModeratorHistoryTurn[];
  /** Segment progress tracker */
  segmentProgress: Array<{
    segmentName: string;
    status: 'planned' | 'in_progress' | 'completed' | 'skipped';
    turnsSpent: number;
    participantProgress: number;  // how many of segment.participantsToAsk are done
  }>;
  /** Current segment index (0-based) — which segment we're currently working through */
  currentSegmentIdx: number;
  /** Turn count so far (completed exchanges, not moderator moves) */
  turnCount: number;
  /** If the previous move was memory_lookup, these are the hits to surface */
  pendingAdHocMemory: MemoryHit[] | null;
  /** True if turn >= 36 — force a close move */
  forceClose: boolean;
  /** Turns remaining until hard end, if turn >= 30 */
  warningTurnsLeft: number | null;
}

export interface ModeratorTurnDecision {
  chosenMove: ModeratorMove;
  /** Seat to address (required for speaking moves, null for memory_lookup/close without a target) */
  targetSeat: number | null;
  /** What the moderator actually says out loud */
  moderatorText: string;
  /** 1-2 sentences explaining why they picked this move — published in the journey */
  reasoning: string;
  /** For memory_lookup moves: the queries the moderator wants to run */
  memoryLookupQueries?: Array<{
    targetSeat: number;
    tags: string[];
    reason: string;
  }>;
  error?: string;
}

// --- Build the moderator prompt ---

function buildModeratorPrompt(state: ModeratorTurnState): { system: string; user: string } {
  const system = `${buildIdentityAnchor(state.moderator)}

You are the moderator of today's dAIly session in the ${state.category.toUpperCase()} category.

THE ROLE — read this carefully before anything else.

The audience is here for the panelists — not for you. Your job is to create the space where the panelists can actually discuss the topic in their own words. Wherever they agree, wherever they disagree, wherever they're uncertain — that's the conversation the audience came for. The more of it is theirs and the less is yours, the better you are doing your job.

Your questions should invite rather than direct. A question that supplies its own answer structure, cites its own sources, and tells the panelist which three sub-points to hit has already done most of the panelist's work for them — and that's the panelist's work, not yours. A good question leaves the panelist room to choose their own frame, find their own shape, and argue in their own voice.

You are refereeing a conversation, not delivering a lecture. You are not the subject-matter expert in the room — the panelists are. You will often know things; resist the urge to show that you know them. If the panelists miss something important, ask about it; don't assert it.

You have an agenda as a playbook, not a script. Follow it when it's working. Diverge when something more interesting surfaces. Close when the panelists have said what needs saying, not when the plan is complete.

Address panelists by name (the name shown at the top of each cast entry below). Seat numbers are an addressing mechanism for the machine; the audience hears names. When you target a panelist in JSON use their seat number, but when you speak to them in moderatorText use their name.

THE EIGHT MOVES:

${Object.entries(MOVE_DESCRIPTIONS).map(([m, d]) => `${m}: ${d}`).join('\n\n')}

OUTPUT FORMAT:
You MUST respond with a single JSON object on every turn:
{
  "chosenMove": "<one of the eight>",
  "targetSeat": <seat number 1-3, or null for memory_lookup/close without a target>,
  "moderatorText": "<what you say out loud — the prompt/question/framing the cast hears>",
  "reasoning": "<1-2 sentences explaining why you picked this move, published in the journey>"
}

For memory_lookup moves, ALSO include:
  "memoryLookupQueries": [ { "targetSeat": <seat>, "tags": ["tag1", "tag2"], "reason": "<why>" } ]
The tags must come from the dAIly tag taxonomy for this category; if you're unsure, name what the participant said and the system will do its best.

For close moves, moderatorText should be your closing remarks — a real synthesis of what surfaced, what's still contested, and what remains unresolved. Not just "thanks for joining".

Your reasoning is PUBLISHED in the session record. The audience sees not just what you said but why you picked each move. Be deliberate.`;

  // Render the agenda
  const agendaBlock = [
    `SESSION FRAMING (your planned opener):`,
    `  ${state.agenda.sessionFraming}`,
    ``,
    `GOALS:`,
    ...state.agenda.goals.map(g => `  - ${g}`),
    ``,
    `PLANNED SEGMENTS:`,
    ...state.agenda.segments.map((s: AgendaSegment, i: number) => {
      const progress = state.segmentProgress[i];
      const statusLabel = progress?.status || 'planned';
      const lines: string[] = [
        `  [${i + 1}] ${s.name} (${s.expectedDuration}) — ${statusLabel.toUpperCase()}`,
        `      Main question: ${s.mainQuestion}`,
        `      Ask seats in order: [${s.participantsToAsk.join(', ')}]`,
        `      Why it matters: ${s.whyItMatters}`,
      ];
      if (s.subQuestions.length > 0) {
        lines.push(`      Sub-questions:`);
        for (const sq of s.subQuestions) lines.push(`        - ${sq}`);
      }
      if (s.relatedResearch.length > 0) {
        lines.push(`      Related research you can draw from:`);
        for (const r of s.relatedResearch) lines.push(`        - ${r.facts}`);
      }
      if (s.relatedMemory.length > 0) {
        lines.push(`      Pre-loaded memory (past statements you can surface):`);
        for (const m of s.relatedMemory) {
          lines.push(`        - Seat ${m.participantSeat} said on ${m.sessionDate}: "${m.pastStatement.slice(0, 200)}" [${m.relevance}]`);
        }
      }
      return lines.join('\n');
    }),
    ``,
    state.agenda.optionalDeepening.length > 0
      ? `OPTIONAL DEEPENING (use only if a tangent points here):\n${state.agenda.optionalDeepening.map(s => `  - ${s.name}: ${s.mainQuestion}`).join('\n')}`
      : '',
    ``,
    `CLOSING FRAME (your planned closing):`,
    `  ${state.agenda.closingFrame}`,
  ].filter(Boolean).join('\n');

  // Render the cast — lead with the model NAME so the moderator refers
  // to panelists by name naturally. Seat number is kept as secondary
  // addressing metadata (it's the JSON targetSeat field).
  const castBlock = state.cast.map(c =>
    `  ${c.modelName} (${c.provider})  —  seat ${c.seat}  —  conflict ${c.conflictScore}/100\n    Stance: ${c.stance}`,
  ).join('\n');

  // Build a seat → name lookup for rendering history with names rather
  // than "SEAT N RESPONDS" labels.
  const nameBySeat = new Map<number, string>();
  for (const c of state.cast) nameBySeat.set(c.seat, c.modelName);
  const nameForSeat = (seat: number | undefined): string =>
    seat !== undefined && nameBySeat.has(seat) ? nameBySeat.get(seat)! : `seat ${seat}`;

  // Render conversation history — each turn labelled by speaker name
  // (moderator or a panelist) rather than seat number.
  const historyBlock = state.history.length === 0
    ? '(The session has not started yet — you are about to make the opening move.)'
    : state.history.map(h => {
        if (h.actor === 'moderator') {
          const target = h.targetSeat ? ` → ${nameForSeat(h.targetSeat)}` : '';
          return `Turn ${h.turnIndex} — Moderator [${h.move}${target}]:\n${h.text}`;
        }
        return `Turn ${h.turnIndex} — ${nameForSeat(h.seat)}:\n${h.text}`;
      }).join('\n\n');

  // Render current progress
  const currentSegment = state.agenda.segments[state.currentSegmentIdx];
  const progressBlock = [
    `CURRENT STATE:`,
    `  Turn count: ${state.turnCount} (target 15-20, hard cap 36)`,
    `  Current segment: ${currentSegment ? `[${state.currentSegmentIdx + 1}] ${currentSegment.name}` : '(beyond planned segments)'}`,
    state.warningTurnsLeft !== null ? `  *** ${state.warningTurnsLeft} TURNS UNTIL HARD END *** — begin wrapping up` : '',
    state.forceClose ? `  *** FORCE CLOSE ACTIVATED — you MUST pick 'close' this turn. Give a graceful closing. ***` : '',
  ].filter(Boolean).join('\n');

  // Render pending ad-hoc memory if present
  const adHocMemoryBlock = state.pendingAdHocMemory && state.pendingAdHocMemory.length > 0
    ? `AD-HOC MEMORY (fetched by your last memory_lookup move — use this on this turn):\n${state.pendingAdHocMemory
        .map(h => `  - [${h.modelId}, ${h.spokenAt.split('T')[0]}]: "${h.utteranceText.slice(0, 300)}"`)
        .join('\n')}`
    : state.pendingAdHocMemory && state.pendingAdHocMemory.length === 0
      ? `AD-HOC MEMORY: Your last memory_lookup returned no hits. Move on.`
      : '';

  const user = `TOPIC: ${state.topicTitle}
${state.topicSignificance.length > 0 ? `SIGNIFICANCE: ${state.topicSignificance.join(' | ')}` : ''}

${agendaBlock}

CAST (address them by the names shown — they do NOT see the agenda):

${castBlock}

CONVERSATION SO FAR:

${historyBlock}

${adHocMemoryBlock}

${progressBlock}

YOUR TASK NOW:

Pick your next move and respond with JSON only. Decide based on what was just said, what the agenda needs, and how the discussion is flowing. Remember:

- You're NOT bound to the plan — but don't deviate without a reason
- Cover the planned segments, but don't grind through them mechanically if tangents are more productive
- Your questions create space for the panelists to speak, not fill it yourself — a one-sentence question is usually better than a three-paragraph one
- Address panelists by name in your moderatorText, not by seat number
- Use memory_lookup sparingly — only when a panelist said something surprising and you want to check their history
- Your reasoning field is public; make it a good one

Respond with JSON only:
{
  "chosenMove": "<one of the eight moves>",
  "targetSeat": <1, 2, 3, or null>,
  "moderatorText": "<what you say out loud>",
  "reasoning": "<1-2 sentences — why this move, why now>"
}`;

  return { system, user };
}

// --- Parse the moderator response ---

function parseModeratorDecision(raw: string): ModeratorTurnDecision | { error: string } {
  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return { error: `No JSON found (length=${raw.length})` };

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const validMoves: ModeratorMove[] = [
      'continue_planned', 'follow_up', 'counter_with_opponent',
      'surface_memory', 'change_direction', 'pull_back',
      'memory_lookup', 'close',
    ];
    const chosenMove = typeof parsed.chosenMove === 'string' && validMoves.includes(parsed.chosenMove as ModeratorMove)
      ? (parsed.chosenMove as ModeratorMove)
      : null;

    if (!chosenMove) return { error: `Invalid chosenMove: ${String(parsed.chosenMove)}` };

    const targetSeat = typeof parsed.targetSeat === 'number' ? parsed.targetSeat
      : parsed.targetSeat === null ? null
      : null;

    const moderatorText = typeof parsed.moderatorText === 'string' ? parsed.moderatorText : '';
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

    let memoryLookupQueries: ModeratorTurnDecision['memoryLookupQueries'];
    if (Array.isArray(parsed.memoryLookupQueries)) {
      memoryLookupQueries = (parsed.memoryLookupQueries as Array<Record<string, unknown>>).map(q => ({
        targetSeat: typeof q.targetSeat === 'number' ? q.targetSeat : 0,
        tags: Array.isArray(q.tags) ? (q.tags as unknown[]).map(String) : [],
        reason: typeof q.reason === 'string' ? q.reason : '',
      }));
    }

    return {
      chosenMove,
      targetSeat,
      moderatorText,
      reasoning,
      memoryLookupQueries,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Main entry point ---

/** Call the moderator to pick their next move and speak. Returns the
 *  structured decision or a fallback 'close' decision if the call
 *  fails (so the debate terminates gracefully rather than hanging). */
export async function callModeratorTurn(
  state: ModeratorTurnState,
): Promise<ModeratorTurnDecision> {
  const { system, user } = buildModeratorPrompt(state);

  let raw: string;
  try {
    // 16000 tokens — this matches the pattern we arrived at for Gemini
    // 2.5 Pro / Flash in deep research synthesis and organize. Thinking
    // models consume internal tokens from this budget; the visible
    // moderator output (move + text + reasoning) is only ~400-800
    // tokens, but Gemini can easily spend 4-8k tokens thinking on a
    // complex turn with this much input (huge agenda + history + all
    // 8 moves). 8000 was too tight — Gemini 2.5 Pro hit the limit
    // before producing any visible output on the very first moderator
    // call and the entire debate collapsed to the error-close fallback.
    //
    // Cost impact is minimal: we only pay for tokens actually
    // generated, not the max budget. Extra headroom is free insurance.
    raw = await callPoolModel(state.moderator, system, user, 16000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    const stack = err instanceof Error ? err.stack : '';
    console.error(`[DEBATE] Moderator call failed for ${state.moderator.displayName}: ${msg}`);
    if (stack) console.error(stack.split('\n').slice(0, 5).join('\n'));
    return {
      chosenMove: 'close',
      targetSeat: null,
      moderatorText: 'I need to end the session here — a technical issue is preventing me from continuing cleanly.',
      reasoning: `Moderator call failed (${state.moderator.displayName}): ${msg}. Gracefully closing.`,
      error: msg,
    };
  }

  const parsed = parseModeratorDecision(raw);
  if ('error' in parsed) {
    console.warn(`[DEBATE] Moderator parse failed: ${parsed.error}. First 500 chars:`);
    console.warn(raw.slice(0, 500));
    return {
      chosenMove: 'close',
      targetSeat: null,
      moderatorText: 'I need to pause the session here — I couldn\'t structure my next move cleanly.',
      reasoning: `Parse failed: ${parsed.error}. Gracefully closing.`,
      error: parsed.error,
    };
  }

  // Enforce forceClose — if the runtime demands it, override the move
  if (state.forceClose && parsed.chosenMove !== 'close') {
    console.warn(`[DEBATE] forceClose active but moderator picked ${parsed.chosenMove} — overriding to close`);
    return {
      ...parsed,
      chosenMove: 'close',
      targetSeat: null,
      moderatorText: parsed.moderatorText || 'We\'ve reached our hard time cap. Final thoughts: this is where I\'ll wrap the session.',
      reasoning: `${parsed.reasoning} [Runtime override: forceClose at turn cap]`,
    };
  }

  console.log(`[DEBATE] Moderator turn: ${parsed.chosenMove}${parsed.targetSeat ? ` → seat ${parsed.targetSeat}` : ''}`);
  return parsed;
}
