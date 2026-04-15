// ============================================================================
// POST /api/daily/cron/prepare — Stage 3 of the daily cron chain
// ============================================================================
// Runs everything between organize and the live debate:
//
//   Stage 3 — Broadcast (votes-only ballot to the pool)
//   Stage 4a — Topic selection (vote scoring, tie detection, runoff,
//              acting moderator if the runoff double-ties)
//   Stage 4b — Focused rebroadcast (per-model conflict + self-veto +
//              stance on the chosen topic)
//   Stage 4c — Moderator selection (tier walk with self-veto filter)
//              OR drop to unmoderated format when no candidate survives
//   Stage 5a — Light research on the topic's source material
//   Stage 5b — Cast selection (moderated: moderator picks;
//              unmoderated: rule-based top-N by focused conflict)
//   Stage 5c-i — Deep research (full-text fetches + targeted web search)
//   Stage 5c-ii — Agenda build (moderated only; skipped if unmoderated)
//
// Pipeline position:
//   create-session  →  organize  →  PREPARE  →  debate
//
// Hard requirement: organize_snapshot MUST exist. If it doesn't, this
// endpoint fails immediately — organize is a separate cron job and
// prepare shouldn't take over its responsibilities. This is the split
// of concerns.
//
// Idempotent per sub-stage: every persisted snapshot is checked
// before re-running its stage. Safe to re-trigger after a partial
// failure.
//
// Expected runtime: ~5-6 minutes.
// Security: CRON_SECRET-gated.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { broadcastToPool, type BroadcastResult } from '@/lib/daily/broadcast';
import type { MergedShortlistEntry, OrganizeResult } from '@/lib/daily/organize';
import { runRunoffBroadcast } from '@/lib/daily/runoff-broadcast';
import {
  scoreVotesTop3,
  detectTie,
  resolveRunoff,
  type RunoffResult,
} from '@/lib/daily/topic-selection';
import {
  getRotationQueue,
  getRecentModeratorRegions,
  selectActingModerator,
  selectModerator,
  type ActingModeratorResult,
  type ModeratorResult,
  type ModeratorSelectionOutcome,
} from '@/lib/daily/moderator-selection';
import {
  runFocusedBroadcast,
  type FocusedBroadcastResult,
  type FocusedBroadcastItem,
} from '@/lib/daily/focused-broadcast';
import {
  researchTopicLight,
  researchTopicDeep,
  type ResearchItem,
  type ResearchResult,
  type DeepResearchResult,
} from '@/lib/daily/research';
import {
  selectCast,
  selectUnmoderatedCast,
  type CastSelectionResult,
} from '@/lib/daily/cast-selection';
import { buildAgenda, type AgendaBuildResult } from '@/lib/daily/agenda';
import { MODEL_POOL } from '@/lib/daily/model-pool';
import { getTodayInForumTz } from '@/lib/daily/schedule';

const DEFAULT_CATEGORY = 'ai';

interface SessionRow {
  id: string;
  category: string;
  session_date: string;
  status: string;
  organize_snapshot: (OrganizeResult & { _startedAt?: string; _completedAt?: string }) | null;
  broadcast_snapshot: BroadcastResult | null;
  focused_broadcast_snapshot: FocusedBroadcastResult | null;
  debate_format: string | null;
  debate_format_reason: string | null;
  selected_thread_id: string | null;
  vote_scores: unknown;
  was_runoff: boolean | null;
  runoff_snapshot: RunoffResult | null;
  was_acting_moderator: boolean | null;
  acting_moderator_model_id: string | null;
  acting_moderator_reasoning: string | null;
  moderator_model_id: string | null;
  research_snapshot: unknown;
  cast_snapshot: unknown;
  session_type: string | null;
  deep_research_snapshot: unknown;
  agenda_snapshot: unknown;
  error: string | null;
}

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { category?: string };
  const category = body.category
    || new URL(request.url).searchParams.get('category')
    || DEFAULT_CATEGORY;
  const sessionDate = getTodayInForumTz();

  console.log(`[PREPARE] Running for ${category} on ${sessionDate}`);

  const supabase = createClient();

  // === Step 1: Load today's session row ===
  const { data: sessionData, error: loadErr } = await supabase
    .from('forum_sessions')
    .select('*')
    .eq('category', category)
    .eq('session_date', sessionDate)
    .maybeSingle();

  if (loadErr || !sessionData) {
    return Response.json({
      error: `No session row for ${category} ${sessionDate}. Run /api/daily/cron/create-session or /api/daily/cron/organize first.`,
    }, { status: 404 });
  }

  const session = sessionData as SessionRow;

  // === Idempotency: already past prepare? ===
  if (session.status === 'agenda_built'
      || session.status === 'debate_in_progress'
      || session.status === 'completed') {
    console.log(`[PREPARE] Session already at ${session.status} — skipping`);
    return Response.json({ session, alreadyComplete: true });
  }

  // === Hard requirement: organize_snapshot must exist ===
  if (!session.organize_snapshot) {
    return Response.json({
      error: 'organize_snapshot missing — run /api/daily/cron/organize first. Prepare does not run organize itself.',
    }, { status: 409 });
  }

  const mergedShortlist: MergedShortlistEntry[] = session.organize_snapshot.mergedShortlist || [];
  if (mergedShortlist.length === 0) {
    await markFailed(supabase, session.id, 'organize_snapshot has empty shortlist — nothing to prepare');
    return Response.json({ error: 'Empty shortlist from organize' }, { status: 400 });
  }

  try {
    // === Step 2: Broadcast (votes-only) ===
    // Re-use existing snapshot if present (idempotent resume).
    let broadcast: BroadcastResult;
    if (session.broadcast_snapshot) {
      console.log('[PREPARE] Using existing broadcast_snapshot');
      broadcast = session.broadcast_snapshot;
    } else {
      const startedAt = new Date().toISOString();
      broadcast = await broadcastToPool(mergedShortlist, category);
      const completedAt = new Date().toISOString();

      await supabase
        .from('forum_sessions')
        .update({
          broadcast_snapshot: {
            _startedAt: startedAt,
            _completedAt: completedAt,
            ...broadcast,
          },
        })
        .eq('id', session.id);
    }

    // === Step 3: Score votes + topic selection ===
    const voteScores = scoreVotesTop3(broadcast.responses);
    const tieDetection = detectTie(voteScores);
    console.log(`[PREPARE] Vote scores: top=${voteScores[0]?.score} winner=${tieDetection.winner?.slice(0, 8) || 'none'} tied=${tieDetection.tiedTopicIds.length}`);

    let selectedThreadId: string | null = session.selected_thread_id || tieDetection.winner;
    let runoffResult: RunoffResult | null = null;
    let runoffStartedAt: string | null = null;
    let runoffCompletedAt: string | null = null;
    let actingModerator: ActingModeratorResult | null = null;
    const wasRunoff = tieDetection.winner === null && tieDetection.tiedTopicIds.length > 1;

    if (!session.selected_thread_id && wasRunoff) {
      console.log(`[PREPARE] Tied — running runoff`);
      const tiedShortlist = mergedShortlist.filter(t => tieDetection.tiedTopicIds.includes(t.threadId));
      runoffStartedAt = new Date().toISOString();
      runoffResult = await runRunoffBroadcast(tiedShortlist, category);
      runoffCompletedAt = new Date().toISOString();

      const runoffResolution = resolveRunoff(runoffResult);
      if (runoffResolution.winner) {
        selectedThreadId = runoffResolution.winner;
      } else if (runoffResolution.stillTiedTopicIds.length > 0) {
        console.log('[PREPARE] Runoff still tied — acting moderator by rotation');
        const queue = await getRotationQueue(category);
        actingModerator = selectActingModerator(queue);
        selectedThreadId = runoffResolution.stillTiedTopicIds[0];
      }
    }

    if (!selectedThreadId) {
      await markFailed(supabase, session.id, 'Topic selection produced no winner');
      return Response.json({ error: 'Topic selection failed', voteScores }, { status: 500 });
    }

    // Persist topic selection if not already
    if (!session.selected_thread_id) {
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
          acting_moderator_reasoning: actingModerator
            ? `Acting moderator picked by pure rotation (no conflict data at this stage). ${actingModerator.modelName} was first in queue.`
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
    }

    // === Step 4: Load topic metadata + thread items (shared by focused broadcast + research) ===
    const selectedShortlistEntry = mergedShortlist.find(e => e.threadId === selectedThreadId);
    const topicTitle = selectedShortlistEntry?.threadTitle
      || (await supabase.from('forum_threads').select('title').eq('id', selectedThreadId).single()).data?.title
      || '(unknown)';
    const topicSignificance = selectedShortlistEntry?.significance || [];
    const topicReadyReasons = (selectedShortlistEntry?.readyReasons || []).map(r => r.reason);

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

    // === Step 5: Focused rebroadcast (Stage 4b) ===
    let focusedBroadcast: FocusedBroadcastResult;
    if (session.focused_broadcast_snapshot) {
      console.log('[PREPARE] Using existing focused_broadcast_snapshot');
      focusedBroadcast = session.focused_broadcast_snapshot;
    } else {
      console.log(`[PREPARE] Running focused rebroadcast on "${topicTitle}"`);
      const startedAt = new Date().toISOString();
      focusedBroadcast = await runFocusedBroadcast({
        topicId: selectedThreadId,
        topicTitle,
        topicSignificance,
        topicReadyReasons,
        items: focusedItems,
        category,
      });
      const completedAt = new Date().toISOString();
      await supabase
        .from('forum_sessions')
        .update({
          focused_broadcast_snapshot: {
            _startedAt: startedAt,
            _completedAt: completedAt,
            ...focusedBroadcast,
          },
        })
        .eq('id', session.id);
    }

    // === Step 6: Moderator selection (Stage 4c) ===
    const queue = await getRotationQueue(category);
    const recentRegions = await getRecentModeratorRegions(category);
    const moderatorOutcome: ModeratorSelectionOutcome = selectModerator(focusedBroadcast, queue, recentRegions);

    let moderator: ModeratorResult | null = null;
    let debateFormat: 'moderated' | 'unmoderated';
    let unmoderatedReason: string | null = null;

    if (moderatorOutcome.kind === 'moderated') {
      moderator = moderatorOutcome.result;
      debateFormat = 'moderated';
      console.log(`[PREPARE] Moderator: ${moderator.modelName} tier=${moderator.tier} conflict=${moderator.conflictScore}`);
    } else {
      debateFormat = 'unmoderated';
      unmoderatedReason = moderatorOutcome.reason;
      console.log(`[PREPARE] Unmoderated fallback: ${moderatorOutcome.dropReason}`);
    }

    await supabase
      .from('forum_sessions')
      .update({
        status: 'moderator_selected',
        moderator_model_id: moderator?.modelId || null,
        moderator_conflict_score: moderator?.conflictScore ?? null,
        moderator_tier: moderator?.tier ?? null,
        moderator_selection_method: moderator?.method
          || (moderatorOutcome.kind === 'unmoderated' ? `unmoderated:${moderatorOutcome.dropReason}` : null),
        moderator_skipped: moderator?.skipped
          || (moderatorOutcome.kind === 'unmoderated' ? moderatorOutcome.skipped : null),
        moderator_region_softcap_applied: moderator?.regionSoftcapApplied ?? false,
        debate_format: debateFormat,
        debate_format_reason: unmoderatedReason,
      })
      .eq('id', session.id);

    // Pick a PoolModel to drive research. Moderated path: the moderator.
    // Unmoderated path: the first rotation queue model (research is
    // fact-gathering, not role-sensitive).
    const researchDriverModel = moderator
      ? MODEL_POOL.find(m => m.id === moderator!.modelId)
      : queue[0]?.model;
    if (!researchDriverModel) {
      throw new Error('No pool model available for research stage');
    }

    // === Step 7: Light research (Stage 5a) ===
    let research: ResearchResult;
    if (session.research_snapshot) {
      console.log('[PREPARE] Using existing research_snapshot');
      research = session.research_snapshot as ResearchResult;
    } else {
      const startedAt = new Date().toISOString();
      research = await researchTopicLight(
        topicTitle,
        topicSignificance,
        researchItems,
        category,
        researchDriverModel,
      );
      const completedAt = new Date().toISOString();
      await supabase
        .from('forum_sessions')
        .update({
          status: 'researched',
          research_snapshot: {
            _startedAt: startedAt,
            _completedAt: completedAt,
            ...research,
          },
        })
        .eq('id', session.id);
    }

    // === Step 8: Cast selection (Stage 5b) ===
    let castResult: CastSelectionResult;
    if (session.cast_snapshot) {
      console.log('[PREPARE] Using existing cast_snapshot');
      castResult = session.cast_snapshot as CastSelectionResult;
    } else {
      const startedAt = new Date().toISOString();
      if (moderator) {
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
        castResult = selectUnmoderatedCast(focusedBroadcast, queue);
      }
      const completedAt = new Date().toISOString();
      await supabase
        .from('forum_sessions')
        .update({
          status: 'cast_selected',
          cast_snapshot: {
            _startedAt: startedAt,
            _completedAt: completedAt,
            ...castResult,
          },
          session_type: castResult.sessionType,
        })
        .eq('id', session.id);
    }

    if (castResult.participants.length === 0) {
      console.warn('[PREPARE] Cast selection produced no participants — stopping');
      return Response.json({
        error: 'Cast selection produced no participants',
        cast: castResult,
      }, { status: 500 });
    }

    // === Step 9: Deep research (Stage 5c-i) ===
    let deepResearch: DeepResearchResult;
    if (session.deep_research_snapshot) {
      console.log('[PREPARE] Using existing deep_research_snapshot');
      deepResearch = session.deep_research_snapshot as DeepResearchResult;
    } else {
      const startedAt = new Date().toISOString();
      deepResearch = await researchTopicDeep(
        topicTitle,
        topicSignificance,
        researchItems,
        category,
        researchDriverModel,
      );
      const completedAt = new Date().toISOString();
      await supabase
        .from('forum_sessions')
        .update({
          status: 'deep_researched',
          deep_research_snapshot: {
            _startedAt: startedAt,
            _completedAt: completedAt,
            ...deepResearch,
          },
        })
        .eq('id', session.id);
    }

    // === Step 10: Agenda build (Stage 5c-ii) — moderated only ===
    if (moderator) {
      if (session.agenda_snapshot) {
        console.log('[PREPARE] Using existing agenda_snapshot');
      } else {
        const moderatorPoolModel = MODEL_POOL.find(m => m.id === moderator.modelId)!;
        const startedAt = new Date().toISOString();
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
        const completedAt = new Date().toISOString();
        await supabase
          .from('forum_sessions')
          .update({
            status: 'agenda_built',
            agenda_snapshot: {
              _startedAt: startedAt,
              _completedAt: completedAt,
              ...agenda,
            },
          })
          .eq('id', session.id);
      }
    } else {
      // Unmoderated: skip agenda, advance status directly
      await supabase
        .from('forum_sessions')
        .update({ status: 'agenda_built' })
        .eq('id', session.id);
    }

    // === Step 11: Return the session ===
    const { data: finalSession } = await supabase
      .from('forum_sessions')
      .select('*')
      .eq('id', session.id)
      .single();

    return Response.json({
      ok: true,
      session: finalSession,
      debateFormat,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[PREPARE] Failed: ${msg}`);
    await markFailed(supabase, session.id, msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// Support GET for Railway schedulers that issue GETs
export const GET = POST;

// --- Helpers ---

async function markFailed(
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
