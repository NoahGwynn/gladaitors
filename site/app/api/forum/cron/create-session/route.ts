// ============================================================================
// POST /api/forum/cron/create-session
// ============================================================================
// Creates today's forum_sessions row with status='scheduled' so the page
// is live with a countdown before the pipeline kicks off. Runs daily at
// midnight (configurable via FORUM_SESSION_CREATE_HOUR) in the forum tz.
//
// Idempotent — if today's row already exists, returns it without creating
// a duplicate.
//
// Security: requires Authorization header with a cron secret. Set
// CRON_SECRET in env. Usable from Railway scheduled jobs OR manually
// via curl for testing.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { getTodayInForumTz } from '@/lib/forum/schedule';

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
