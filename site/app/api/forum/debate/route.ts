// ============================================================================
// POST /api/forum/debate — Stage 6: run the debate session
// ============================================================================
// Runs the structured debate for a session that has status 'agenda_built'.
// Separate from /api/forum/select because debates are long-running:
// 15-36 exchange turns × 2 LLM calls per turn = potentially 70+ flagship
// calls in a single request, lasting 15-30 minutes.
//
// The endpoint:
//   1. Looks up the session (by category/date or by explicit sessionId)
//   2. Verifies it's in 'agenda_built' state
//   3. Loads the agenda, cast, moderator, and topic from the stored
//      snapshots
//   4. Runs runDebate()
//   5. Persists debate_snapshot with timestamps
//   6. Marks the session 'completed'
//
// Idempotent — if called on a session already past 'agenda_built',
// returns the existing row without re-running the debate.
//
// Body:
//   { "category": "ai" }           — runs today's session for the category
//   { "sessionId": "<uuid>" }       — runs a specific session
//
// No auth — internal tool. Add auth before deploy.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { runDebate, runUnmoderatedDebate } from '@/lib/forum/debate-runtime';
import { MODEL_POOL } from '@/lib/forum/model-pool';
import type { Agenda, AgendaBuildResult } from '@/lib/forum/agenda';
import type { CastParticipant, CastSelectionResult } from '@/lib/forum/cast-selection';

export async function POST(request: NextRequest) {
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
    const category = body.category || 'ai';
    const sessionDate = new Date().toISOString().split('T')[0];
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

  // Idempotency: if already past agenda_built, return as-is
  if (session.status === 'completed' || session.debate_snapshot) {
    console.log(`[DEBATE-ENDPOINT] Session ${session.id.slice(0, 8)} already has debate_snapshot — returning existing`);
    return Response.json({ session, alreadyComplete: true });
  }

  if (session.status !== 'agenda_built') {
    return Response.json(
      {
        error: `Session status is '${session.status}' — must be 'agenda_built' to run the debate. Run /api/forum/select first.`,
      },
      { status: 400 },
    );
  }

  // === Load the required snapshots ===
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

  // === Load the thread title ===
  const { data: thread } = await supabase
    .from('forum_threads')
    .select('title')
    .eq('id', session.selected_thread_id)
    .single();

  const topicTitle = thread?.title || '(unknown topic)';

  // Pull significance from the merged shortlist in organize_snapshot if available
  const organizeSnapshot = session.organize_snapshot as {
    mergedShortlist?: Array<{ threadId: string; significance?: string[] }>;
  } | null;
  const significanceEntry = organizeSnapshot?.mergedShortlist?.find(
    (t) => t.threadId === session.selected_thread_id,
  );
  const topicSignificance: string[] = significanceEntry?.significance || [];

  // === Run the debate — branch on format ===
  console.log(`[DEBATE-ENDPOINT] Starting ${debateFormat} debate for session ${session.id.slice(0, 8)}: "${topicTitle}"`);

  const startedAt = new Date().toISOString();
  let debateSnapshot;

  if (debateFormat === 'unmoderated') {
    // No moderator, no agenda — sequential exchange
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
    // Moderated path — needs agenda + moderator pool model
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

  const completedAt = new Date().toISOString();

  // === Persist + mark session completed ===
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
