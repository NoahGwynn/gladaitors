// ============================================================================
// POST /api/forum/select — Stages 4 + 5: topic, focused rebroadcast,
// moderator (or unmoderated drop), research, cast, deep research, agenda
// ============================================================================
// The full pipeline through cast / agenda assembly:
//
//   STAGE 4a — topic selection
//    1. Look up (or create) today's forum_sessions row
//    2. Run Stages 2 + 3 if no broadcast_snapshot exists
//    3. Score votes, detect tie, runoff if needed, acting moderator if needed
//    4. Persist the topic pick
//
//   STAGE 4b — focused rebroadcast (new)
//    5. Re-ask every pool model about the winning topic: conflict score,
//       unfit-to-moderate self-veto, stance. Persist focused snapshot.
//
//   STAGE 4c — moderator selection (reads from focused snapshot)
//    6. Walk graduated tiers 1..4 after filtering self-vetoes. If every
//       candidate scored ≥80 or self-vetoed → drop to unmoderated format
//       and skip steps 7/8/10 (no moderator-driven cast, no agenda).
//
//   STAGE 5a — light research (always runs)
//    7. Light research on the chosen topic (no moderator needed; any
//       available pool model can research). In the unmoderated branch
//       we pick the first model in rotation as the researcher.
//
//   STAGE 5b — cast selection
//    8. MODERATED: moderator picks 2-3 cast members + session type
//       UNMODERATED: rule-based — top-N by focused conflict DESC
//
//   STAGE 5c — deep research + agenda
//    9. MODERATED: deep research + agenda build as before
//       UNMODERATED: deep research still runs (shared facts); agenda build
//                    is skipped entirely (no chair to follow a plan)
//
// Idempotent per (category, session_date).
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
  type ModeratorSelectionOutcome,
} from '@/lib/forum/moderator-selection';
import {
  runFocusedBroadcast,
  type FocusedBroadcastResult,
  type FocusedBroadcastItem,
} from '@/lib/forum/focused-broadcast';
import {
  researchTopicLight,
  researchTopicDeep,
  type ResearchItem,
  type ResearchResult,
  type DeepResearchResult,
} from '@/lib/forum/research';
import {
  selectCast,
  selectUnmoderatedCast,
  type CastSelectionResult,
} from '@/lib/forum/cast-selection';
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
  focused_broadcast_snapshot: FocusedBroadcastResult | null;
  debate_format: string | null;
  debate_format_reason: string | null;
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

  if (session.status === 'agenda_built' || session.status === 'completed') {
    console.log(`[SELECT] Session already ${session.status} — returning existing row`);
    return Response.json({ session, alreadyComplete: true });
  }

  // Flip the status to in_progress immediately so the live UI exits
  // ScheduledState and starts rendering the scrubber as the pipeline
  // works through organize + broadcast (which can take several minutes
  // before the first status-advancing stage writes its snapshot).
  if (session.status === 'scheduled') {
    await supabase
      .from('forum_sessions')
      .update({ status: 'in_progress' })
      .eq('id', session.id);
    session = { ...session, status: 'in_progress' };
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

      const organizeStartedAt = new Date().toISOString();
      const organizeResult = await organizeThreads(category);
      const organizeCompletedAt = new Date().toISOString();
      mergedShortlist = organizeResult.mergedShortlist;

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

      const broadcastStartedAt = new Date().toISOString();
      broadcast = await broadcastToPool(mergedShortlist, category);
      const broadcastCompletedAt = new Date().toISOString();

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
        // === Step 6: Acting moderator (now pure rotation) ===
        // The initial broadcast no longer collects conflict data, so
        // acting moderator selection is rotation-only. The picker
        // takes the first untied topic for the acting mod's call —
        // there's no conflict-based tiebreak available.
        console.log(`[SELECT] Runoff still tied — selecting acting moderator by rotation`);
        const queue = await getRotationQueue(category);
        actingModerator = selectActingModerator(queue);
        console.log(`[SELECT] Acting moderator: ${actingModerator.modelName} (${actingModerator.method})`);

        // Without conflict data, pick the first still-tied topic
        // deterministically. This is a rare edge case of an edge case.
        selectedThreadId = runoffResolution.stillTiedTopicIds[0];
        console.log(`[SELECT] Acting moderator chose ${selectedThreadId.slice(0, 8)} (first still-tied, no conflict data to tiebreak)`);
      }
    }

    if (!selectedThreadId) {
      await markSessionFailed(supabase, session.id, 'Topic selection produced no winner');
      return Response.json({ error: 'Topic selection failed', voteScores, tieDetection, runoffResult }, { status: 500 });
    }

    // === Step 7: Persist topic selection ===
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
        acting_moderator_tier: null,
        acting_moderator_conflicts: null,
        acting_moderator_reasoning: actingModerator
          ? `Acting moderator picked by pure rotation (initial broadcast is votes-only, no conflict data available at this stage). ${actingModerator.modelName} was first in the rotation queue.`
          : null,
      })
      .eq('id', session.id);

    await supabase
      .from('forum_threads')
      .update({
        status: 'discussed',
        discussed_at: new Date().toISOString(),
        session_id: session.id,
      })
      .eq('id', selectedThreadId);

    console.log(`[SELECT] Topic selected: ${selectedThreadId.slice(0, 8)}`);

    // === Step 8: Load topic metadata for downstream stages ===
    const selectedShortlistEntry = (mergedShortlist || (session.organize_snapshot as { mergedShortlist?: MergedShortlistEntry[] } | null)?.mergedShortlist || [])
      .find(e => e.threadId === selectedThreadId);
    const topicTitle = selectedShortlistEntry?.threadTitle
      || (await supabase.from('forum_threads').select('title').eq('id', selectedThreadId).single()).data?.title
      || '(unknown)';
    const topicSignificance = selectedShortlistEntry?.significance || [];
    const topicReadyReasons = (selectedShortlistEntry?.readyReasons || []).map(r => r.reason);

    // Load underlying thread items — used by focused broadcast AND
    // research. Fetching once here so both stages share the data.
    const { data: threadItems } = await supabase
      .from('forum_items')
      .select('id, title, summary, url, source_id, published_at')
      .eq('thread_id', selectedThreadId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(20);

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

    const focusedItems: FocusedBroadcastItem[] = researchItems.map(i => ({
      title: i.title,
      publishedAt: i.publishedAt,
      sourceName: i.sourceName,
      summary: i.summary,
    }));

    // === Step 9: Focused rebroadcast (Stage 4b) ===
    console.log(`[SELECT] Running focused rebroadcast on "${topicTitle}"`);
    const focusedStartedAt = new Date().toISOString();
    const focusedBroadcast = await runFocusedBroadcast({
      topicId: selectedThreadId,
      topicTitle,
      topicSignificance,
      topicReadyReasons,
      items: focusedItems,
      category,
    });
    const focusedCompletedAt = new Date().toISOString();

    await supabase
      .from('forum_sessions')
      .update({
        focused_broadcast_snapshot: {
          _startedAt: focusedStartedAt,
          _completedAt: focusedCompletedAt,
          ...focusedBroadcast,
        },
      })
      .eq('id', session.id);

    // === Step 10: Moderator selection (Stage 4c) ===
    const queue = await getRotationQueue(category);
    const recentRegions = await getRecentModeratorRegions(category);
    const moderatorOutcome: ModeratorSelectionOutcome = selectModerator(focusedBroadcast, queue, recentRegions);

    let moderator: ModeratorResult | null = null;
    let debateFormat: 'moderated' | 'unmoderated';
    let unmoderatedReason: string | null = null;

    if (moderatorOutcome.kind === 'moderated') {
      moderator = moderatorOutcome.result;
      debateFormat = 'moderated';
      console.log(`[SELECT] Moderator: ${moderator.modelName} (tier=${moderator.tier}, method=${moderator.method}, conflict=${moderator.conflictScore}, skipped=${moderator.skipped.length})`);
    } else {
      debateFormat = 'unmoderated';
      unmoderatedReason = moderatorOutcome.reason;
      console.log(`[SELECT] No moderator — ${moderatorOutcome.dropReason}. Dropping to unmoderated format.`);
      console.log(`[SELECT] Reason: ${moderatorOutcome.reason}`);
    }

    await supabase
      .from('forum_sessions')
      .update({
        status: 'moderator_selected',
        moderator_model_id: moderator?.modelId || null,
        moderator_conflict_score: moderator?.conflictScore ?? null,
        moderator_tier: moderator?.tier ?? null,
        moderator_selection_method: moderator?.method || (moderatorOutcome.kind === 'unmoderated' ? `unmoderated:${moderatorOutcome.dropReason}` : null),
        moderator_skipped: moderator?.skipped || (moderatorOutcome.kind === 'unmoderated' ? moderatorOutcome.skipped : null),
        moderator_region_softcap_applied: moderator?.regionSoftcapApplied ?? false,
        debate_format: debateFormat,
        debate_format_reason: unmoderatedReason,
      })
      .eq('id', session.id);

    // For the moderated path, resolve the moderator's PoolModel.
    // For the unmoderated path, pick the first rotation queue model
    // (any available pool model) to run the light research step —
    // research is just fact-gathering, not role-sensitive.
    const researchDriverModel = moderator
      ? MODEL_POOL.find(m => m.id === moderator!.modelId)
      : queue[0]?.model;
    if (!researchDriverModel) {
      throw new Error('No pool model available for research stage');
    }

    // === Step 11: Light research (Stage 5a) ===
    const researchStartedAt = new Date().toISOString();
    const research: ResearchResult = await researchTopicLight(
      topicTitle,
      topicSignificance,
      researchItems,
      category,
      researchDriverModel,
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

    // === Step 12: Cast selection (Stage 5b) ===
    const castStartedAt = new Date().toISOString();
    let castResult: CastSelectionResult;
    if (moderator) {
      // Moderated path: the moderator picks the cast
      const moderatorPoolModel = MODEL_POOL.find(m => m.id === moderator.modelId);
      if (!moderatorPoolModel) {
        throw new Error(`Moderator model ${moderator.modelId} not found in MODEL_POOL`);
      }
      castResult = await selectCast(
        topicTitle,
        topicSignificance,
        research,
        moderatorPoolModel,
        focusedBroadcast,
        category,
      );
    } else {
      // Unmoderated path: rule-based (top-N by focused conflict DESC)
      castResult = selectUnmoderatedCast(focusedBroadcast, queue);
    }
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
        moderator: moderatorOutcome,
        focusedBroadcast,
        research,
        cast: castResult,
        warning: 'Cast selection produced no participants',
      });
    }

    // === Step 13: Deep research (Stage 5c-i) ===
    const deepResearchStartedAt = new Date().toISOString();
    const deepResearch: DeepResearchResult = await researchTopicDeep(
      topicTitle,
      topicSignificance,
      researchItems,
      category,
      researchDriverModel,
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

    // === Step 14: Agenda build (Stage 5c-ii) — moderated only ===
    let agenda: AgendaBuildResult | null = null;
    if (moderator) {
      const moderatorPoolModel = MODEL_POOL.find(m => m.id === moderator.modelId)!;
      const agendaStartedAt = new Date().toISOString();
      agenda = await buildAgenda(
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
        })
        .eq('id', session.id);
    } else {
      // Unmoderated: skip agenda build and advance status directly
      await supabase
        .from('forum_sessions')
        .update({ status: 'agenda_built' })
        .eq('id', session.id);
    }

    // === Step 15: Return the full session record ===
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
      moderator: moderatorOutcome,
      focusedBroadcast,
      research,
      cast: castResult,
      deepResearch,
      agenda,
      debateFormat,
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
