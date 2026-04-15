// ============================================================================
// POST /api/daily/cron/create-session — Stage 1 of the daily cron chain
// ============================================================================
// Creates today's forum_sessions row with status='scheduled' so the page
// has something to render before organize runs. Railway fires this once
// per day at whatever time you configure in its cron dashboard.
//
// Pipeline position:
//   create-session  →  organize  →  prepare  →  debate
//
// Idempotent — if today's row already exists, returns it without
// creating a duplicate. Safe to re-run manually.
//
// Security: CRON_SECRET-gated. Set CRON_SECRET in env and include
// `Authorization: Bearer ${CRON_SECRET}` in the request. If CRON_SECRET
// is unset (dev mode), the endpoint is open.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { getTodayInForumTz } from '@/lib/daily/schedule';

const DEFAULT_CATEGORY = 'ai';

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured — allow (dev mode). Document this clearly
    // before deploying to prod.
    return true;
  }
  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as {
    category?: string;
    date?: string;
  };

  const category = body.category || DEFAULT_CATEGORY;
  const sessionDate = body.date || getTodayInForumTz();

  const supabase = createClient();

  // Check if the row already exists
  const { data: existing } = await supabase
    .from('forum_sessions')
    .select('id, status')
    .eq('category', category)
    .eq('session_date', sessionDate)
    .maybeSingle();

  if (existing) {
    return Response.json({
      created: false,
      session: existing,
      message: 'Session already exists for this date',
    });
  }

  // Create with status='scheduled' — the UI uses this to render the
  // countdown state before the pipeline runs.
  const { data: created, error } = await supabase
    .from('forum_sessions')
    .insert({
      category,
      session_date: sessionDate,
      status: 'scheduled',
    })
    .select('*')
    .single();

  if (error || !created) {
    return Response.json({ error: error?.message || 'create failed' }, { status: 500 });
  }

  return Response.json({
    created: true,
    session: created,
  });
}

// Also support GET for Railway's scheduled jobs that only issue GET requests
export const GET = POST;
