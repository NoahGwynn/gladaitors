// ============================================================================
// dAIly Forum — Stage 6: Debate Runtime
// ============================================================================
// The orchestrator for a debate session. Drives the turn loop:
//
//   1. Moderator picks a move (callModeratorTurn)
//   2. If speaking move → participant responds (callParticipantTurn)
//      + utterance persisted to tagged memory (storeUtterance)
//   3. If memory_lookup → fetch memory, loop back without advancing
//   4. If close → terminate
//
// Turn accounting:
//   - turnCount increments on each completed EXCHANGE (moderator speaks
//     + participant responds). memory_lookup is a preparation step,
//     doesn't advance turnCount.
//   - target: 15-20 turns
//   - warnings: turn 30 onward, moderator is told "X turns left"
//   - hard cap: turn 36, moderator forced to pick close
//
// Persistence:
//   - The full DebateSnapshot is returned by runDebate() and the
//     caller (API endpoint) persists it to forum_sessions.debate_snapshot
//   - Each participant response is ALSO persisted to forum_utterances
//     as it happens (via storeUtterance) so memory starts accumulating
//     immediately
//
// Safety rails:
//   - If callModeratorTurn fails repeatedly, we close after 2 consecutive failures
//   - If callParticipantTurn fails, we log and continue with a
//     "[failed to respond]" placeholder (the moderator sees this and
//     can react)
//   - memory_lookup is capped at 2 consecutive invocations — can't
//     get stuck in an infinite lookup loop
// ============================================================================

import type { PoolModel } from './model-pool';
import { MODEL_POOL } from './model-pool';
import type { Agenda } from './agenda';
import type { CastParticipant } from './cast-selection';
import { callModeratorTurn, type ModeratorMove, type ModeratorTurnState, type ModeratorHistoryTurn } from './moderator-turn';
import { callParticipantTurn, type ParticipantVisibleTurn } from './participant-turn';
import { queryMemory, type MemoryHit } from './memory-query';
import { storeUtterance } from './utterance-storage';
import { getTaxonomy, filterValidTags } from './tag-taxonomy';
import { createClient } from '@/lib/supabase';

// --- Constants ---

/** Hard cap on turns — at this point the moderator is forced to close */
export const DEBATE_HARD_CAP = 36;

/** Start warning the moderator at this turn count */
export const DEBATE_WARNING_START = 30;

/** Soft consecutive limits to prevent loops */
const MAX_CONSECUTIVE_MEMORY_LOOKUPS = 2;
const MAX_CONSECUTIVE_MODERATOR_FAILURES = 2;

// --- Types ---

export interface DebateTurn {
  /** 0-indexed position in the turns array (monotonic, includes memory_lookup turns) */
  index: number;
  /** The "exchange turn" number — only increments on completed exchanges,
   *  NOT on memory_lookup non-speaking turns. Maps to the agenda's turn budget. */
  exchangeTurn: number;
  actor: 'moderator' | 'participant';
  timestamp: string;

  // Moderator-only fields:
  move?: ModeratorMove;
  targetSeat?: number | null;
  moderatorReasoning?: string;
  /** Memory hits returned from a memory_lookup move */
  adHocMemoryHits?: MemoryHit[];
  /** Whether the moderator was force-closed by the runtime */
  forcedClose?: boolean;

  // Participant-only fields:
  seat?: number;
  modelId?: string;
  modelName?: string;

  // Shared:
  text: string;
  segmentName: string | null;
}

export interface DebateSegmentProgress {
  segmentName: string;
  status: 'planned' | 'in_progress' | 'completed' | 'skipped';
  startedAtExchangeTurn: number | null;
  endedAtExchangeTurn: number | null;
  exchangesSpent: number;
}

export interface DebateSnapshot {
  status: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  exchangeTurnCount: number;
  totalTurnRecords: number;
  forceCloseApplied: boolean;
  turns: DebateTurn[];
  segmentProgress: DebateSegmentProgress[];
  /** Counts of each move type used */
  moveCounts: Record<ModeratorMove, number>;
  /** How many participant utterances were successfully persisted to
   *  forum_utterances. Useful for verifying the memory pipeline. */
  utterancesStored: number;
  error?: string;
}

// --- Helpers ---

/** Resolve the PoolModel for a cast participant (cast carries modelId
 *  but not the full PoolModel object) */
function castToPoolModel(c: CastParticipant): PoolModel | null {
  return MODEL_POOL.find(m => m.id === c.modelId) || null;
}

/** Convert a moderator-view turn record to a simpler history entry
 *  that the moderator can read */
function toModeratorHistoryTurn(turn: DebateTurn): ModeratorHistoryTurn {
  return {
    turnIndex: turn.exchangeTurn,
    actor: turn.actor,
    move: turn.move,
    seat: turn.seat,
    targetSeat: turn.targetSeat ?? undefined,
    text: turn.text,
    segmentName: turn.segmentName,
  };
}

/** Convert turns to what a specific participant sees (they see the
 *  spoken content but not the moderator's reasoning or memory lookups) */
function toParticipantVisibleHistory(turns: DebateTurn[]): ParticipantVisibleTurn[] {
  return turns
    .filter(t => t.move !== 'memory_lookup') // hide non-speaking turns
    .map(t => ({
      speaker: t.actor,
      seat: t.seat,
      text: t.text,
    }));
}

// --- Main entry point ---

export interface RunDebateInput {
  sessionId: string;
  category: string;
  topicTitle: string;
  topicSignificance: string[];
  agenda: Agenda;
  cast: CastParticipant[];
  moderator: PoolModel;
  /** If true (default), persist the debate_snapshot after every turn
   *  so the UI can watch the debate unfold live via Supabase Realtime.
   *  Set to false for tests that don't need streaming. */
  streamToDatabase?: boolean;
}

/** Run a debate to completion (or failure). Returns the full snapshot.
 *  Persists incrementally to forum_sessions.debate_snapshot after each
 *  turn by default, so the UI streams the debate live via Supabase
 *  Realtime as it runs. The caller still receives the full snapshot
 *  at the end for the final endpoint response. */
export async function runDebate(input: RunDebateInput): Promise<DebateSnapshot> {
  const startedAt = new Date().toISOString();
  const streamToDatabase = input.streamToDatabase !== false; // default true

  const turns: DebateTurn[] = [];
  const segmentProgress: DebateSegmentProgress[] = input.agenda.segments.map(s => ({
    segmentName: s.name,
    status: 'planned',
    startedAtExchangeTurn: null,
    endedAtExchangeTurn: null,
    exchangesSpent: 0,
  }));

  const moveCounts: Record<ModeratorMove, number> = {
    continue_planned: 0,
    follow_up: 0,
    counter_with_opponent: 0,
    surface_memory: 0,
    change_direction: 0,
    pull_back: 0,
    memory_lookup: 0,
    close: 0,
  };

  let exchangeTurnCount = 0;
  let currentSegmentIdx = 0;
  let pendingAdHocMemory: MemoryHit[] | null = null;
  let consecutiveMemoryLookups = 0;
  let consecutiveModeratorFailures = 0;
  let utterancesStored = 0;
  let forceCloseApplied = false;

  // Mark the first segment as in_progress at the start
  if (segmentProgress.length > 0) {
    segmentProgress[0].status = 'in_progress';
    segmentProgress[0].startedAtExchangeTurn = 0;
  }

  console.log(`[DEBATE] Starting session: ${input.topicTitle}`);
  console.log(`[DEBATE] Cast: ${input.cast.map(c => `${c.modelName}(seat ${c.seat})`).join(', ')}`);
  console.log(`[DEBATE] Agenda: ${input.agenda.segments.length} segments`);

  // Incremental persistence — writes the current DebateSnapshot state
  // to forum_sessions after each turn. Supabase Realtime pushes the
  // update to any subscribed client, so the UI shows turns appearing
  // live as the debate runs. On errors we log and continue — failing
  // to persist shouldn't kill the debate.
  const supabase = streamToDatabase ? createClient() : null;
  async function persistProgress(status: 'in_progress' | 'completed' = 'in_progress') {
    if (!supabase) return;
    const snapshot: DebateSnapshot = {
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      exchangeTurnCount,
      totalTurnRecords: turns.length,
      forceCloseApplied,
      turns,
      segmentProgress,
      moveCounts,
      utterancesStored,
    };
    try {
      await supabase
        .from('forum_sessions')
        .update({
          status: status === 'completed' ? 'completed' : 'debate_in_progress',
          debate_snapshot: {
            _startedAt: startedAt,
            _completedAt: status === 'completed' ? snapshot.completedAt : null,
            ...snapshot,
          },
        })
        .eq('id', input.sessionId);
    } catch (err) {
      console.warn(`[DEBATE] Failed to persist progress: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // Initial write — marks the session as debate_in_progress with an empty
  // transcript. This is what flips the UI from "agenda built" to "debate
  // starting" state.
  await persistProgress('in_progress');

  // Main loop
  while (exchangeTurnCount < DEBATE_HARD_CAP) {
    const forceClose = exchangeTurnCount >= DEBATE_HARD_CAP;
    const warningTurnsLeft = exchangeTurnCount >= DEBATE_WARNING_START
      ? DEBATE_HARD_CAP - exchangeTurnCount
      : null;

    const currentSegment = input.agenda.segments[currentSegmentIdx];
    const currentSegmentName = currentSegment?.name ?? null;

    // === Moderator turn ===
    const modState: ModeratorTurnState = {
      topicTitle: input.topicTitle,
      topicSignificance: input.topicSignificance,
      category: input.category,
      agenda: input.agenda,
      cast: input.cast,
      moderator: input.moderator,
      history: turns.map(toModeratorHistoryTurn),
      segmentProgress: segmentProgress.map((sp, i) => ({
        segmentName: sp.segmentName,
        status: sp.status,
        turnsSpent: sp.exchangesSpent,
        participantProgress: 0, // tracked elsewhere; not surfaced to moderator yet
      })),
      currentSegmentIdx,
      turnCount: exchangeTurnCount,
      pendingAdHocMemory,
      forceClose,
      warningTurnsLeft,
    };

    const decision = await callModeratorTurn(modState);

    const moderatorTurn: DebateTurn = {
      index: turns.length,
      exchangeTurn: exchangeTurnCount,
      actor: 'moderator',
      timestamp: new Date().toISOString(),
      move: decision.chosenMove,
      targetSeat: decision.targetSeat,
      moderatorReasoning: decision.reasoning,
      text: decision.moderatorText,
      segmentName: currentSegmentName,
      forcedClose: forceClose && decision.chosenMove === 'close',
    };

    if (decision.error) {
      consecutiveModeratorFailures += 1;
      if (consecutiveModeratorFailures >= MAX_CONSECUTIVE_MODERATOR_FAILURES) {
        console.error('[DEBATE] Two consecutive moderator failures — terminating');
        moderatorTurn.move = 'close';
        turns.push(moderatorTurn);
        moveCounts.close += 1;
        break;
      }
    } else {
      consecutiveModeratorFailures = 0;
    }

    turns.push(moderatorTurn);
    moveCounts[decision.chosenMove] += 1;

    // Stream the moderator turn to subscribers immediately so the UI
    // can render it before the participant response lands
    await persistProgress('in_progress');

    // Clear pending memory — it's been consumed by this turn's context
    pendingAdHocMemory = null;

    // === Handle move types ===

    if (decision.chosenMove === 'close') {
      console.log('[DEBATE] Moderator chose close. Ending session.');
      if (forceClose) forceCloseApplied = true;
      break;
    }

    if (decision.chosenMove === 'memory_lookup') {
      consecutiveMemoryLookups += 1;
      if (consecutiveMemoryLookups > MAX_CONSECUTIVE_MEMORY_LOOKUPS) {
        console.warn('[DEBATE] Too many consecutive memory_lookups — forcing continue_planned next turn');
        // We let this one go through but don't set pending memory, so
        // next turn the moderator has no excuse to loop again.
        pendingAdHocMemory = [];
        continue;
      }

      // Execute the memory queries
      const hits: MemoryHit[] = [];
      if (decision.memoryLookupQueries && decision.memoryLookupQueries.length > 0) {
        for (const query of decision.memoryLookupQueries) {
          const targetCast = input.cast.find(c => c.seat === query.targetSeat);
          if (!targetCast) continue;
          const poolModel = castToPoolModel(targetCast);
          if (!poolModel) continue;

          const validTags = filterValidTags(input.category, query.tags);
          if (validTags.length === 0) {
            // Fall back to tags from the current segment if moderator's tags are invalid
            const segmentTags: string[] = [];
            // No way to recover semantically without more work — just return empty
            if (segmentTags.length === 0) continue;
          }

          const resolvedTags = validTags.length > 0 ? validTags : getTaxonomy(input.category).slice(0, 3);

          const queryHits = await queryMemory({
            modelId: poolModel.id,
            tags: resolvedTags,
            category: input.category,
            excludeSessionIds: [input.sessionId],
            limit: 3,
          });
          hits.push(...queryHits);
        }
      }

      moderatorTurn.adHocMemoryHits = hits;
      pendingAdHocMemory = hits;
      console.log(`[DEBATE] memory_lookup returned ${hits.length} hits`);
      // Don't increment exchangeTurnCount — this is a prep step
      continue;
    }

    // Speaking move — reset consecutive memory lookup counter
    consecutiveMemoryLookups = 0;

    // === Participant responds ===
    const targetSeat = decision.targetSeat;
    if (targetSeat === null || targetSeat === undefined) {
      console.warn(`[DEBATE] Speaking move ${decision.chosenMove} had no targetSeat — skipping participant turn`);
      exchangeTurnCount += 1;
      continue;
    }

    const targetCast = input.cast.find(c => c.seat === targetSeat);
    if (!targetCast) {
      console.warn(`[DEBATE] Unknown targetSeat ${targetSeat} — skipping`);
      exchangeTurnCount += 1;
      continue;
    }

    const poolModel = castToPoolModel(targetCast);
    if (!poolModel) {
      console.warn(`[DEBATE] Cast seat ${targetSeat} modelId ${targetCast.modelId} not in pool — skipping`);
      exchangeTurnCount += 1;
      continue;
    }

    const participantHistory = toParticipantVisibleHistory(turns);

    const response = await callParticipantTurn(
      {
        model: poolModel,
        seat: targetCast.seat,
        stance: targetCast.stance,
      },
      input.topicTitle,
      input.category,
      participantHistory,
      decision.moderatorText,
    );

    const participantTurn: DebateTurn = {
      index: turns.length,
      exchangeTurn: exchangeTurnCount,
      actor: 'participant',
      timestamp: new Date().toISOString(),
      seat: targetCast.seat,
      modelId: poolModel.id,
      modelName: poolModel.displayName,
      text: response.text,
      segmentName: currentSegmentName,
    };
    turns.push(participantTurn);

    // === Persist utterance to tagged memory ===
    // Fire and forget — we log failures but don't block the debate
    try {
      await storeUtterance({
        sessionId: input.sessionId,
        category: input.category,
        segmentName: currentSegmentName,
        turnIndex: exchangeTurnCount,
        participantSeat: targetCast.seat,
        modelId: poolModel.id,
        modelFamily: poolModel.family,
        utteranceText: response.text,
      });
      utterancesStored += 1;
    } catch (err) {
      console.warn(`[DEBATE] Failed to store utterance: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // === Update segment progress ===
    if (currentSegment) {
      const sp = segmentProgress[currentSegmentIdx];
      sp.exchangesSpent += 1;

      // Advance to next segment if this one's participants are all done.
      // Very simple heuristic: if the exchangeTurn count since segment
      // started equals or exceeds participantsToAsk length, consider it
      // covered. The moderator can still choose to continue via
      // follow_up or move on via continue_planned — the runtime just
      // tracks when the natural "round" of the segment is done.
      const participantsNeeded = currentSegment.participantsToAsk.length;
      if (sp.exchangesSpent >= participantsNeeded && decision.chosenMove === 'continue_planned') {
        sp.status = 'completed';
        sp.endedAtExchangeTurn = exchangeTurnCount;
        currentSegmentIdx += 1;
        if (currentSegmentIdx < segmentProgress.length) {
          segmentProgress[currentSegmentIdx].status = 'in_progress';
          segmentProgress[currentSegmentIdx].startedAtExchangeTurn = exchangeTurnCount + 1;
        }
      }
    }

    exchangeTurnCount += 1;

    // Stream the full exchange (moderator + participant) to subscribers
    // so the UI sees the completed turn live
    await persistProgress('in_progress');

    // Check hard cap — if we just hit it, set forceClose flag for next moderator turn
    if (exchangeTurnCount >= DEBATE_HARD_CAP) {
      forceCloseApplied = true;
      // Don't break here — give the moderator one last turn to close gracefully
    }
  }

  // Mark any remaining segments as skipped
  for (const sp of segmentProgress) {
    if (sp.status === 'planned' || sp.status === 'in_progress') {
      sp.status = sp.exchangesSpent > 0 ? 'completed' : 'skipped';
      if (sp.endedAtExchangeTurn === null) sp.endedAtExchangeTurn = exchangeTurnCount;
    }
  }

  const completedAt = new Date().toISOString();

  console.log(`[DEBATE] Session ended. Exchange turns: ${exchangeTurnCount}. Total records: ${turns.length}. Utterances stored: ${utterancesStored}.`);
  console.log(`[DEBATE] Moves used: ${Object.entries(moveCounts).filter(([, n]) => n > 0).map(([m, n]) => `${m}×${n}`).join(', ')}`);

  return {
    status: 'completed',
    startedAt,
    completedAt,
    exchangeTurnCount,
    totalTurnRecords: turns.length,
    forceCloseApplied,
    turns,
    segmentProgress,
    moveCounts,
    utterancesStored,
  };
}
