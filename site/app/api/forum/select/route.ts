// ============================================================================
// POST /api/forum/select — Run Stage 4: topic + moderator selection
// ============================================================================
// The full Stage 4 pipeline:
//
//   1. Look up (or create) today's forum_sessions row for this category
//   2. If the row has no broadcast_snapshot, run Stage 3 (organize + broadcast)
//   3. Score the votes (top-3 cutoff)
//   4. Detect tie (within 10% margin)
//   5. If tied: run runoff → resolve picks → resolve urgency
//   6. If still tied: select acting moderator → acting mod picks
//   7. Persist topic selection (forum_sessions + forum_threads.session_id)
//   8. Run actual moderator selection
//   9. Persist moderator selection
//  10. Return full session record
//
// Idempotent per (category, session_date) — running the same day either
// returns the existing session or resumes from where it failed.
//
// Body:
//   { "category": "ai" }
//
// Optional override for testing:
//   { "category": "ai", "broadcastOverride": { ... full BroadcastResult ... } }
//
// No auth — internal tool. Add auth before deploy.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { broadcastToPool, type BroadcastResult } from '@/lib/forum/broadcast';
import { organizeThreads, type MergedShortlistEntry } from '@/lib/forum/organize';
import { runRunoffBroadcast } from '@/lib/forum/runoff-broadcast';
import {
  scoreVotesTop3,
  detectTie,
  resolveRunoff,
  type RunoffResult,
} from '@/lib/forum/topic-selection';
import {
  getRotationQueue,
  getRecentModeratorRegions,
  selectActingModerator,
  selectModerator,
  type ActingModeratorResult,
  type ModeratorResult,
} from '@/lib/forum/moderator-selection';

interface SessionRow {
  id: string;
  category: string;
  session_date: string;
  status: string;
  broadcast_snapshot: BroadcastResult | null;
  selected_thread_id: string | null;
  vote_scores: unknown;
  was_runoff: boolean;
  runoff_snapshot: RunoffResult | null;
  was_acting_moderator: boolean;
  acting_moderator_model_id: string | null;
  acting_moderator_tier: number | null;
  acting_moderator_reasoning: string | null;
  acting_moderator_conflicts: unknown;
  moderator_model_id: string | null;
  moderator_conflict_score: number | null;
  moderator_selection_method: string | null;
  moderator_skipped: unknown;
  moderator_region_softcap_applied: boolean;
  session_summary: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    category?: string;
    broadcastOverride?: BroadcastResult;
  };
  const category = body.category || 'ai';
  const sessionDate = new Date().toISOString().split('T')[0];

  console.log(`[SELECT] Starting Stage 4 for ${category} on ${sessionDate}`);

  const supabase = createClient();

  // === Step 1: Look up or create today's session row ===
  let session = await getOrCreateSession(supabase, category, sessionDate);
  if (!session) {
    return Response.json({ error: 'Failed to create session row' }, { status: 500 });
  }

  // If the session is already complete, return it as-is (idempotent)
  if (session.status === 'moderator_selected' || session.status === 'completed') {
    console.log(`[SELECT] Session already ${session.status} — returning existing row`);
    return Response.json({ session, alreadyComplete: true });
  }

  try {
    // === Step 2: Get a broadcast snapshot ===
    let broadcast: BroadcastResult;
    let mergedShortlist: MergedShortlistEntry[] | null = null;

    if (body.broadcastOverride) {
      console.log('[SELECT] Using broadcastOverride from request body');
      broadcast = body.broadcastOverride;
    } else if (session.broadcast_snapshot) {
      console.log('[SELECT] Using existing broadcast_snapshot from session row');
      broadcast = session.broadcast_snapshot;
    } else {
      console.log('[SELECT] No broadcast snapshot — running Stage 2 + Stage 3');
      const organizeResult = await organizeThreads(category);
      mergedShortlist = organizeResult.mergedShortlist;

      if (mergedShortlist.length === 0) {
        await markSessionFailed(supabase, session.id, 'Stage 2 produced empty shortlist');
        return Response.json({
          error: 'Stage 2 produced an empty shortlist — nothing to select from',
          organizeResult,
        }, { status: 400 });
      }

      broadcast = await broadcastToPool(mergedShortlist, category);

      // Persist the snapshot so subsequent runs reuse it
      await supabase
        .from('forum_sessions')
        .update({ broadcast_snapshot: broadcast })
        .eq('id', session.id);
    }

    // We need the merged shortlist for runoff context (to render the
    // tied topics with full prior reasoning). If we used a stored
    // snapshot or override, we don't have it — re-derive from organize.
    // This is only invoked if a runoff is needed; otherwise it's wasted.
    const getShortlist = async (): Promise<MergedShortlistEntry[]> => {
      if (mergedShortlist) return mergedShortlist;
      console.log('[SELECT] Re-deriving merged shortlist for runoff context');
      const result = await organizeThreads(category);
      mergedShortlist = result.mergedShortlist;
      return mergedShortlist;
    };

    // === Step 3: Score votes ===
    const voteScores = scoreVotesTop3(broadcast.responses);
    console.log(`[SELECT] Scored ${voteScores.length} threads. Top: ${voteScores[0]?.score} pts`);

    // === Step 4: Detect tie ===
    const tieDetection = detectTie(voteScores);
    console.log(`[SELECT] Tie detection: winner=${tieDetection.winner?.slice(0, 8) || 'none'}, tied=${tieDetection.tiedTopicIds.length}, margin=${tieDetection.marginToSecondPct?.toFixed(1) || 'n/a'}%`);

    let selectedThreadId: string | null = tieDetection.winner;
    let runoffResult: RunoffResult | null = null;
    let actingModerator: ActingModeratorResult | null = null;
    const wasRunoff = tieDetection.winner === null && tieDetection.tiedTopicIds.length > 1;

    // === Step 5: Runoff if tied ===
    if (wasRunoff) {
      console.log(`[SELECT] Tied — running runoff with ${tieDetection.tiedTopicIds.length} topics`);
      const fullShortlist = await getShortlist();
      const tiedShortlist = fullShortlist.filter(t => tieDetection.tiedTopicIds.includes(t.threadId));
      runoffResult = await runRunoffBroadcast(tiedShortlist, category);

      const runoffResolution = resolveRunoff(runoffResult);
      console.log(`[SELECT] Runoff: resolvedBy=${runoffResolution.resolvedBy}, winner=${runoffResolution.winner?.slice(0, 8) || 'none'}, stillTied=${runoffResolution.stillTiedTopicIds.length}`);

      if (runoffResolution.winner) {
        selectedThreadId = runoffResolution.winner;
      } else if (runoffResolution.stillTiedTopicIds.length > 0) {
        // === Step 6: Acting moderator decides ===
        console.log(`[SELECT] Runoff still tied — selecting acting moderator`);
        const queue = await getRotationQueue(category);
        actingModerator = selectActingModerator(
          runoffResolution.stillTiedTopicIds,
          broadcast,
          queue,
        );
        console.log(`[SELECT] Acting moderator: ${actingModerator.modelName} (tier ${actingModerator.tier})`);

        // The acting moderator's choice is determined by their own
        // conflict pattern: pick the topic where their conflict is
        // lowest. This is the deterministic decision rule — we don't
        // re-call the model. The transparency layer publishes the
        // acting mod's full conflict picture so readers can see why.
        const sorted = Object.entries(actingModerator.conflicts)
          .sort((a, b) => a[1] - b[1]);
        selectedThreadId = sorted[0]?.[0] || runoffResolution.stillTiedTopicIds[0];
        console.log(`[SELECT] Acting moderator chose ${selectedThreadId.slice(0, 8)} (lowest of their conflicts)`);
      }
    }

    if (!selectedThreadId) {
      await markSessionFailed(supabase, session.id, 'Topic selection produced no winner');
      return Response.json({ error: 'Topic selection failed', voteScores, tieDetection, runoffResult }, { status: 500 });
    }

    // === Step 7: Persist topic selection ===
    await supabase
      .from('forum_sessions')
      .update({
        status: 'topic_selected',
        selected_thread_id: selectedThreadId,
        vote_scores: voteScores,
        was_runoff: wasRunoff,
        runoff_snapshot: runoffResult,
        was_acting_moderator: actingModerator !== null,
        acting_moderator_model_id: actingModerator?.modelId || null,
        acting_moderator_tier: actingModerator?.tier || null,
        acting_moderator_conflicts: actingModerator?.conflicts || null,
        acting_moderator_reasoning: actingModerator
          ? `Tier ${actingModerator.tier} (max conflict ${actingModerator.maxConflict}). Picked the topic with their lowest conflict score among the tied set.`
          : null,
      })
      .eq('id', session.id);

    // Update the thread itself to mark it as discussed
    await supabase
      .from('forum_threads')
      .update({
        status: 'discussed',
        discussed_at: new Date().toISOString(),
        session_id: session.id,
      })
      .eq('id', selectedThreadId);

    console.log(`[SELECT] Topic selected: ${selectedThreadId.slice(0, 8)}`);

    // === Step 8: Actual moderator selection ===
    const queue = await getRotationQueue(category);
    const recentRegions = await getRecentModeratorRegions(category);
    const moderator: ModeratorResult = selectModerator(selectedThreadId, broadcast, queue, recentRegions);
    console.log(`[SELECT] Moderator: ${moderator.modelName} (tier=${moderator.tier ?? 'fallback'}, method=${moderator.method}, conflict=${moderator.conflictScore}, skipped=${moderator.skipped.length}, regionSoftcap=${moderator.regionSoftcapApplied})`);

    // === Step 9: Persist moderator + complete session ===
    await supabase
      .from('forum_sessions')
      .update({
        status: 'moderator_selected',
        moderator_model_id: moderator.modelId,
        moderator_conflict_score: moderator.conflictScore,
        moderator_tier: moderator.tier,
        moderator_selection_method: moderator.method,
        moderator_skipped: moderator.skipped,
        moderator_region_softcap_applied: moderator.regionSoftcapApplied,
        completed_at: new Date().toISOString(),
      })
      .eq('id', session.id);

    // === Step 10: Return the full session record ===
    const { data: finalSession } = await supabase
      .from('forum_sessions')
      .select('*')
      .eq('id', session.id)
      .single();

    return Response.json({
      session: finalSession,
      voteScores,
      tieDetection,
      runoffResult,
      actingModerator,
      moderator,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[SELECT] Stage 4 failed: ${msg}`);
    await markSessionFailed(supabase, session.id, msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// --- Helpers ---

async function getOrCreateSession(
  supabase: ReturnType<typeof createClient>,
  category: string,
  sessionDate: string,
): Promise<SessionRow | null> {
  const { data: existing } = await supabase
    .from('forum_sessions')
    .select('*')
    .eq('category', category)
    .eq('session_date', sessionDate)
    .maybeSingle();

  if (existing) return existing as SessionRow;

  const { data: created, error } = await supabase
    .from('forum_sessions')
    .insert({
      category,
      session_date: sessionDate,
      status: 'in_progress',
    })
    .select('*')
    .single();

  if (error || !created) {
    console.error(`[SELECT] Failed to create session row:`, error?.message);
    return null;
  }

  return created as SessionRow;
}

async function markSessionFailed(
  supabase: ReturnType<typeof createClient>,
  sessionId: string,
  errorMsg: string,
): Promise<void> {
  await supabase
    .from('forum_sessions')
    .update({
      status: 'failed',
      error: errorMsg,
      completed_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
}
