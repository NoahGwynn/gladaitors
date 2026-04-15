// ============================================================================
// POST /api/daily/cron/organize — Stage 2 of the daily cron chain
// ============================================================================
// Runs the editorial organize step: two AI organizers independently
// shortlist today's news threads, their picks are merged, and the
// result is written to forum_sessions.organize_snapshot.
//
// Pipeline position:
//   create-session  →  ORGANIZE  →  prepare  →  debate
//
// This is a SEPARATE stage from prepare (the old /api/daily/select ran
// both together). Splitting them lets organize run as late as possible
// before prepare — capturing news that broke during the US East morning
// window — while still leaving a short inspection gap for operators to
// kill the day if the shortlist is garbage.
//
// Idempotent — if organize_snapshot already exists for today's session,
// returns it without re-running. Safe to re-trigger if the first run
// failed partway through.
//
// Expected runtime: ~2 minutes (two parallel organizer LLM calls).
// Security: CRON_SECRET-gated.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { organizeThreads } from '@/lib/daily/organize';
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
  };
  const category = body.category
    || new URL(request.url).searchParams.get('category')
    || DEFAULT_CATEGORY;
  const sessionDate = getTodayInForumTz();

  console.log(`[ORGANIZE] Running for ${category} on ${sessionDate}`);

  const supabase = createClient();

  // === Step 1: Ensure today's session row exists ===
  // Organize needs a row to write its snapshot to. If create-session
  // hasn't run yet (or someone skipped it), create one here so we're
  // not blocked on another cron. Idempotent.
  const { data: existing } = await supabase
    .from('forum_sessions')
    .select('*')
    .eq('category', category)
    .eq('session_date', sessionDate)
    .maybeSingle();

  let session = existing;
  if (!session) {
    const { data: created, error: createErr } = await supabase
      .from('forum_sessions')
      .insert({ category, session_date: sessionDate, status: 'scheduled' })
      .select('*')
      .single();
    if (createErr || !created) {
      return Response.json({
        error: `Failed to create session row: ${createErr?.message || 'unknown'}`,
      }, { status: 500 });
    }
    session = created;
    console.log(`[ORGANIZE] Created session row ${session.id.slice(0, 8)}`);
  }

  // === Step 2: Idempotency check ===
  if (session.organize_snapshot) {
    console.log(`[ORGANIZE] organize_snapshot already exists for ${session.id.slice(0, 8)} — skipping`);
    return Response.json({
      session,
      alreadyComplete: true,
      message: 'Organize already ran for this session',
    });
  }

  // === Step 3: Flip status to in_progress so the UI exits scheduled state ===
  if (session.status === 'scheduled') {
    await supabase
      .from('forum_sessions')
      .update({ status: 'in_progress' })
      .eq('id', session.id);
  }

  // === Step 4: Run organize ===
  try {
    const startedAt = new Date().toISOString();
    const result = await organizeThreads(category);
    const completedAt = new Date().toISOString();

    await supabase
      .from('forum_sessions')
      .update({
        organize_snapshot: {
          _startedAt: startedAt,
          _completedAt: completedAt,
          ...result,
        },
      })
      .eq('id', session.id);

    console.log(`[ORGANIZE] Done: ${result.mergedShortlist.length} threads on the shortlist`);

    return Response.json({
      ok: true,
      sessionId: session.id,
      shortlistCount: result.mergedShortlist.length,
      threadsEvaluated: result.threadsEvaluated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[ORGANIZE] Failed: ${msg}`);
    await supabase
      .from('forum_sessions')
      .update({ status: 'failed', error: msg, completed_at: new Date().toISOString() })
      .eq('id', session.id);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// Support GET for Railway schedulers that issue GET requests
export const GET = POST;
