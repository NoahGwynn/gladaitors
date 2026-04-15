// ============================================================================
// POST /api/daily/cron/debate — Stage 4 of the daily cron chain
// ============================================================================
// Runs Stage 6 — the actual debate. Moderated sessions walk through
// their agenda with a moderator driving the turn loop; unmoderated
// sessions run the sequential seat-cycle format. Branch is chosen
// based on session.debate_format set by prepare.
//
// Pipeline position:
//   create-session  →  organize  →  prepare  →  DEBATE
//
// Hard requirement: session must be at status 'agenda_built'. If
// agenda isn't built yet, prepare hasn't finished — this endpoint
// refuses to run.
//
// Idempotent — if the session already has a debate_snapshot it returns
// the existing record without re-running. This matters because the
// debate is the most expensive stage; we NEVER want to accidentally
// double-run it.
//
// Expected runtime: ~8-15 minutes depending on turn length. Must run
// on a long-running host (Railway / Render) — will exceed Vercel's
// 5-minute function timeout.
//
// Security: CRON_SECRET-gated.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { runDebate, runUnmoderatedDebate } from '@/lib/daily/debate-runtime';
import { MODEL_POOL } from '@/lib/daily/model-pool';
import type { Agenda, AgendaBuildResult } from '@/lib/daily/agenda';
import type { CastParticipant, CastSelectionResult } from '@/lib/daily/cast-selection';
import type { ResearchResult, DeepResearchResult } from '@/lib/daily/research';
import { runModerationPipeline } from '@/lib/daily/moderation-pipeline';
import { getTodayInForumTz } from '@/lib/daily/schedule';

const DEFAULT_CATEGORY = 'ai';

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

  const body = await request.json().catch(() => ({})) as {
    category?: string;
    sessionId?: string;
  };

  const supabase = createClient();

  // === Resolve the session ===
  let session;
  if (body.sessionId) {
    const { data } = await supabase
      .from('forum_sessions')
      .select('*')
      .eq('id', body.sessionId)
      .maybeSingle();
    session = data;
  } else {
    const category = body.category
      || new URL(request.url).searchParams.get('category')
      || DEFAULT_CATEGORY;
    const sessionDate = getTodayInForumTz();
    const { data } = await supabase
      .from('forum_sessions')
      .select('*')
      .eq('category', category)
      .eq('session_date', sessionDate)
      .maybeSingle();
    session = data;
  }

  if (!session) {
    return Response.json({ error: 'No session found' }, { status: 404 });
  }

  // === Idempotency: already finished? ===
  if (session.status === 'completed' || session.debate_snapshot) {
    console.log(`[DEBATE-CRON] Session ${session.id.slice(0, 8)} already has debate_snapshot — returning existing`);
    return Response.json({ session, alreadyComplete: true });
  }

  if (session.status !== 'agenda_built') {
    return Response.json(
      {
        error: `Session status is '${session.status}' — must be 'agenda_built' to run the debate. Run /api/daily/cron/prepare first.`,
      },
      { status: 400 },
    );
  }

  // === Load the cast ===
  const castSnapshot = session.cast_snapshot as CastSelectionResult | null;
  if (!castSnapshot) {
    return Response.json({ error: 'Session has no cast_snapshot' }, { status: 400 });
  }
  const cast: CastParticipant[] = castSnapshot.participants;
  if (cast.length === 0) {
    return Response.json({ error: 'Session has an empty cast' }, { status: 400 });
  }

  const debateFormat: 'moderated' | 'unmoderated' = session.debate_format === 'unmoderated'
    ? 'unmoderated'
    : 'moderated';

  // === Topic metadata ===
  const { data: thread } = await supabase
    .from('forum_threads')
    .select('title')
    .eq('id', session.selected_thread_id)
    .single();

  const topicTitle = thread?.title || '(unknown topic)';

  const organizeSnapshot = session.organize_snapshot as {
    mergedShortlist?: Array<{ threadId: string; significance?: string[] }>;
  } | null;
  const significanceEntry = organizeSnapshot?.mergedShortlist?.find(
    (t) => t.threadId === session.selected_thread_id,
  );
  const topicSignificance: string[] = significanceEntry?.significance || [];

  // === Run the debate — branch on format ===
  console.log(`[DEBATE-CRON] Starting ${debateFormat} debate for session ${session.id.slice(0, 8)}: "${topicTitle}"`);

  const startedAt = new Date().toISOString();
  let debateSnapshot;

  try {
    if (debateFormat === 'unmoderated') {
      const unmoderatedReason = (session.debate_format_reason as string | null)
        || 'No pool model could moderate this topic. Session runs in unmoderated format.';
      debateSnapshot = await runUnmoderatedDebate({
        sessionId: session.id,
        category: session.category,
        topicTitle,
        topicSignificance,
        cast,
        unmoderatedReason,
      });
    } else {
      const agendaSnapshot = session.agenda_snapshot as AgendaBuildResult | null;
      if (!agendaSnapshot) {
        return Response.json({ error: 'Moderated session has no agenda_snapshot' }, { status: 400 });
      }
      const agenda: Agenda = {
        sessionFraming: agendaSnapshot.sessionFraming,
        goals: agendaSnapshot.goals,
        segments: agendaSnapshot.segments,
        optionalDeepening: agendaSnapshot.optionalDeepening,
        closingFrame: agendaSnapshot.closingFrame,
      };
      const moderatorPoolModel = MODEL_POOL.find(m => m.id === session.moderator_model_id);
      if (!moderatorPoolModel) {
        return Response.json({ error: `Moderator ${session.moderator_model_id} not in pool` }, { status: 500 });
      }
      debateSnapshot = await runDebate({
        sessionId: session.id,
        category: session.category,
        topicTitle,
        topicSignificance,
        agenda,
        cast,
        moderator: moderatorPoolModel,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[DEBATE-CRON] Failed: ${msg}`);
    await supabase
      .from('forum_sessions')
      .update({
        status: 'failed',
        error: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', session.id);
    return Response.json({ error: msg }, { status: 500 });
  }

  const completedAt = new Date().toISOString();

  // Persist the debate snapshot immediately — the moderation pipeline
  // runs next but we want the debate visible in the transparency layer
  // even while moderation is still deciding, so the operator can see
  // exactly what was generated.
  await supabase
    .from('forum_sessions')
    .update({
      debate_snapshot: {
        _startedAt: startedAt,
        _completedAt: completedAt,
        ...debateSnapshot,
      },
    })
    .eq('id', session.id);

  // === Stage 7: Shared moderation pipeline ===
  // Every generated debate goes through three Sonnet-class screening
  // checks before publication. If any critical finding is raised, the
  // session is held and the operator clears it manually. The critical
  // rule: skipping a day is always acceptable; publishing a bad day
  // is not.
  console.log(`[DEBATE-CRON] Running moderation pipeline...`);
  const research = session.research_snapshot as ResearchResult | null;
  const deepResearch = session.deep_research_snapshot as DeepResearchResult | null;

  if (!research) {
    // Shouldn't happen — prepare always writes research_snapshot.
    // Defensive: hold the session and log.
    console.error('[DEBATE-CRON] research_snapshot missing — cannot run hallucination check. Holding for moderation.');
    await supabase
      .from('forum_sessions')
      .update({
        status: 'held_for_moderation',
        completed_at: completedAt,
        error: 'research_snapshot missing at moderation stage — held for manual review',
      })
      .eq('id', session.id);
    return Response.json({
      error: 'research_snapshot missing; session held for manual review',
      sessionId: session.id,
    }, { status: 500 });
  }

  let moderationResult;
  try {
    moderationResult = await runModerationPipeline({
      category: session.category,
      topicTitle,
      topicSignificance,
      debateSnapshot,
      research,
      deepResearch: deepResearch || null,
      cast,
    });
  } catch (err) {
    // A moderation-pipeline-level crash holds the session rather than
    // failing it outright. The debate output is already persisted;
    // the operator can decide whether to publish manually.
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[DEBATE-CRON] Moderation pipeline crashed: ${msg}`);
    await supabase
      .from('forum_sessions')
      .update({
        status: 'held_for_moderation',
        completed_at: completedAt,
        error: `Moderation pipeline crashed: ${msg}`,
      })
      .eq('id', session.id);
    return Response.json({
      error: `Moderation pipeline crashed: ${msg}`,
      sessionId: session.id,
    }, { status: 500 });
  }

  // Persist the moderation snapshot and decide final status
  const finalStatus =
    moderationResult.decision === 'publish'
      ? 'completed'
      : 'held_for_moderation';

  await supabase
    .from('forum_sessions')
    .update({
      status: finalStatus,
      moderation_snapshot: moderationResult,
      completed_at: completedAt,
    })
    .eq('id', session.id);

  console.log(`[DEBATE-CRON] Session ${session.id.slice(0, 8)} → ${finalStatus}. ${moderationResult.decisionReason}`);

  const { data: finalSession } = await supabase
    .from('forum_sessions')
    .select('*')
    .eq('id', session.id)
    .single();

  return Response.json({
    session: finalSession,
    debate: debateSnapshot,
    moderation: moderationResult,
    status: finalStatus,
  });
}

// Support GET for Railway schedulers
export const GET = POST;
