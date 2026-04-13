// ============================================================================
// POST /api/forum/select — Run Stages 4 + 5a/5b: topic, moderator, research, cast
// ============================================================================
// The full pipeline through cast selection:
//
//   STAGE 4 — topic + moderator
//    1. Look up (or create) today's forum_sessions row for this category
//    2. If the row has no broadcast_snapshot, run Stages 2 + 3
//    3. Score votes, detect tie, runoff if needed, acting moderator if needed
//    4. Persist topic selection + run actual moderator selection
//
//   STAGE 5a — light research
//    5. Load the items attached to the chosen thread
//    6. Moderator reads + synthesises into a research note
//    7. Persist research_snapshot
//
//   STAGE 5b — cast selection
//    8. Moderator picks 2-3 cast members + session type, informed by research
//    9. Persist cast_snapshot + session_type
//   10. Mark session 'cast_selected' (NOT 'completed' — Stage 5c + 6 still pending)
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
import {
  researchTopicLight,
  researchTopicDeep,
  type ResearchItem,
  type ResearchResult,
  type DeepResearchResult,
} from '@/lib/forum/research';
import { selectCast, type CastSelectionResult } from '@/lib/forum/cast-selection';
import { buildAgenda, type AgendaBuildResult } from '@/lib/forum/agenda';
import { MODEL_POOL } from '@/lib/forum/model-pool';

interface SessionRow {
  id: string;
  category: string;
  session_date: string;
  status: string;
  organize_snapshot: unknown;
  research_snapshot: unknown;
  cast_snapshot: unknown;
  session_type: string | null;
  deep_research_snapshot: unknown;
  agenda_snapshot: unknown;
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

  // If the session has fully run Stage 5 (through agenda build), return
  // it as-is (idempotent). Earlier states still re-run to pick up from
  // where they failed — the resume mechanism is the snapshot checks
  // inside each stage (e.g. broadcast_snapshot) which short-circuit
  // the LLM calls if the data already exists.
  if (session.status === 'agenda_built' || session.status === 'completed') {
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

      // --- Stage 2: organize ---
      const organizeStartedAt = new Date().toISOString();
      const organizeResult = await organizeThreads(category);
      const organizeCompletedAt = new Date().toISOString();
      mergedShortlist = organizeResult.mergedShortlist;

      // Persist the organize snapshot (with timestamps) so the journey
      // derivation function can reconstruct the Stage 2 timeline. We
      // do this BEFORE the empty-shortlist guard so failed sessions
      // still have the organize trace.
      await supabase
        .from('forum_sessions')
        .update({
          organize_snapshot: {
            _startedAt: organizeStartedAt,
            _completedAt: organizeCompletedAt,
            ...organizeResult,
          },
        })
        .eq('id', session.id);

      if (mergedShortlist.length === 0) {
        await markSessionFailed(supabase, session.id, 'Stage 2 produced empty shortlist');
        return Response.json({
          error: 'Stage 2 produced an empty shortlist — nothing to select from',
          organizeResult,
        }, { status: 400 });
      }

      // --- Stage 3: broadcast ---
      const broadcastStartedAt = new Date().toISOString();
      broadcast = await broadcastToPool(mergedShortlist, category);
      const broadcastCompletedAt = new Date().toISOString();

      // Persist the broadcast snapshot (with timestamps)
      await supabase
        .from('forum_sessions')
        .update({
          broadcast_snapshot: {
            _startedAt: broadcastStartedAt,
            _completedAt: broadcastCompletedAt,
            ...broadcast,
          },
        })
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
    let runoffStartedAt: string | null = null;
    let runoffCompletedAt: string | null = null;
    let actingModerator: ActingModeratorResult | null = null;
    const wasRunoff = tieDetection.winner === null && tieDetection.tiedTopicIds.length > 1;

    // === Step 5: Runoff if tied ===
    if (wasRunoff) {
      console.log(`[SELECT] Tied — running runoff with ${tieDetection.tiedTopicIds.length} topics`);
      const fullShortlist = await getShortlist();
      const tiedShortlist = fullShortlist.filter(t => tieDetection.tiedTopicIds.includes(t.threadId));
      runoffStartedAt = new Date().toISOString();
      runoffResult = await runRunoffBroadcast(tiedShortlist, category);
      runoffCompletedAt = new Date().toISOString();

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
    // Wrap the runoff snapshot with timestamps for the journey UI.
    const runoffSnapshotPersisted = runoffResult
      ? { _startedAt: runoffStartedAt, _completedAt: runoffCompletedAt, ...runoffResult }
      : null;

    await supabase
      .from('forum_sessions')
      .update({
        status: 'topic_selected',
        selected_thread_id: selectedThreadId,
        vote_scores: voteScores,
        was_runoff: wasRunoff,
        runoff_snapshot: runoffSnapshotPersisted,
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

    // === Step 9: Persist moderator selection ===
    // NOTE: completed_at is NOT set yet — Stage 5a/5b still pending.
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
      })
      .eq('id', session.id);

    // Resolve the moderator's PoolModel record for the LLM calls
    const moderatorPoolModel = MODEL_POOL.find(m => m.id === moderator.modelId);
    if (!moderatorPoolModel) {
      throw new Error(`Moderator model ${moderator.modelId} not found in MODEL_POOL`);
    }

    // === Step 10: Stage 5a — light research ===
    // Load the items attached to the chosen thread so the moderator
    // can read the source material before picking the cast.
    const { data: threadItems } = await supabase
      .from('forum_items')
      .select('id, title, summary, url, source_id, published_at')
      .eq('thread_id', selectedThreadId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(20);

    // Resolve source names for each item
    const sourceIds = [...new Set((threadItems || []).map(i => i.source_id))];
    const sourceNameById = new Map<string, string>();
    if (sourceIds.length > 0) {
      const { data: sources } = await supabase
        .from('forum_sources')
        .select('id, name')
        .in('id', sourceIds);
      for (const s of sources || []) sourceNameById.set(s.id, s.name);
    }

    const researchItems: ResearchItem[] = (threadItems || []).map(item => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      url: item.url,
      sourceName: sourceNameById.get(item.source_id) || 'unknown',
      publishedAt: item.published_at,
    }));

    // Get the topic's title + significance for the research/cast prompts
    const selectedShortlistEntry = mergedShortlist?.find(e => e.threadId === selectedThreadId);
    const topicTitle = selectedShortlistEntry?.threadTitle
      || (await supabase.from('forum_threads').select('title').eq('id', selectedThreadId).single()).data?.title
      || '(unknown)';
    const topicSignificance = selectedShortlistEntry?.significance || [];

    const researchStartedAt = new Date().toISOString();
    const research: ResearchResult = await researchTopicLight(
      topicTitle,
      topicSignificance,
      researchItems,
      category,
      moderatorPoolModel,
    );
    const researchCompletedAt = new Date().toISOString();

    await supabase
      .from('forum_sessions')
      .update({
        status: 'researched',
        research_snapshot: {
          _startedAt: researchStartedAt,
          _completedAt: researchCompletedAt,
          ...research,
        },
      })
      .eq('id', session.id);

    // === Step 11: Stage 5b — cast selection ===
    const castStartedAt = new Date().toISOString();
    const castResult: CastSelectionResult = await selectCast(
      topicTitle,
      topicSignificance,
      research,
      moderatorPoolModel,
      broadcast,
      selectedThreadId,
      category,
    );
    const castCompletedAt = new Date().toISOString();

    await supabase
      .from('forum_sessions')
      .update({
        status: 'cast_selected',
        cast_snapshot: {
          _startedAt: castStartedAt,
          _completedAt: castCompletedAt,
          ...castResult,
        },
        session_type: castResult.sessionType,
      })
      .eq('id', session.id);

    // === Step 12: Stage 5c-i — deep research ===
    // Gracefully degrade if cast selection failed (can't proceed to
    // agenda without a cast — return what we have).
    if (castResult.participants.length === 0) {
      console.warn('[SELECT] Cast selection produced no participants — skipping deep research and agenda');
      const { data: partial } = await supabase
        .from('forum_sessions')
        .select('*')
        .eq('id', session.id)
        .single();
      return Response.json({
        session: partial,
        voteScores,
        tieDetection,
        runoffResult,
        actingModerator,
        moderator,
        research,
        cast: castResult,
        warning: 'Cast selection produced no participants',
      });
    }

    const deepResearchStartedAt = new Date().toISOString();
    const deepResearch: DeepResearchResult = await researchTopicDeep(
      topicTitle,
      topicSignificance,
      researchItems,
      category,
      moderatorPoolModel,
    );
    const deepResearchCompletedAt = new Date().toISOString();

    await supabase
      .from('forum_sessions')
      .update({
        status: 'deep_researched',
        deep_research_snapshot: {
          _startedAt: deepResearchStartedAt,
          _completedAt: deepResearchCompletedAt,
          ...deepResearch,
        },
      })
      .eq('id', session.id);

    // === Step 13: Stage 5c-ii — agenda build ===
    const agendaStartedAt = new Date().toISOString();
    const agenda: AgendaBuildResult = await buildAgenda(
      topicTitle,
      topicSignificance,
      research,
      deepResearch,
      castResult.participants,
      castResult.sessionType,
      moderatorPoolModel,
      category,
      session.id,
    );
    const agendaCompletedAt = new Date().toISOString();

    await supabase
      .from('forum_sessions')
      .update({
        status: 'agenda_built',
        agenda_snapshot: {
          _startedAt: agendaStartedAt,
          _completedAt: agendaCompletedAt,
          ...agenda,
        },
        // completed_at intentionally NOT set yet — Stage 6 (debate) still pending
      })
      .eq('id', session.id);

    // === Step 14: Return the full session record ===
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
      research,
      cast: castResult,
      deepResearch,
      agenda,
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
