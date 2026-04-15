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

  await supabase
    .from('forum_sessions')
    .update({
      status: 'completed',
      debate_snapshot: {
        _startedAt: startedAt,
        _completedAt: completedAt,
        ...debateSnapshot,
      },
      completed_at: completedAt,
    })
    .eq('id', session.id);

  const { data: finalSession } = await supabase
    .from('forum_sessions')
    .select('*')
    .eq('id', session.id)
    .single();

  return Response.json({
    session: finalSession,
    debate: debateSnapshot,
  });
}

// Support GET for Railway schedulers
export const GET = POST;
