// ============================================================================
// GET /api/forum/journey?category=ai&date=YYYY-MM-DD
// ============================================================================
// Returns the derived journey timeline for a single forum session.
// The journey is the published audit trail of how the topic and
// moderator were chosen — every step the pipeline took, in order,
// with structured data for the UI to render.
//
// If `date` is omitted, returns today's session for the category.
//
// The journey is derived on every request from the snapshots stored
// on the forum_sessions row. There is no parallel events table —
// the row IS the journey.
// ============================================================================

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase';
import { deriveSessionJourney, type SessionRowForJourney } from '@/lib/forum/journey';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const category = url.searchParams.get('category') || 'ai';
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

  const supabase = createClient();

  const { data: session, error } = await supabase
    .from('forum_sessions')
    .select('*')
    .eq('category', category)
    .eq('session_date', date)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!session) {
    return Response.json({ error: 'No session found for this category and date' }, { status: 404 });
  }

  const journey = deriveSessionJourney(session as SessionRowForJourney);

  return Response.json({
    session: {
      id: session.id,
      category: session.category,
      session_date: session.session_date,
      status: session.status,
      created_at: session.created_at,
      completed_at: session.completed_at,
    },
    journey,
  });
}
