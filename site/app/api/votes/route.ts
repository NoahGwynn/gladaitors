// ============================================================================
// /api/votes — read aggregate vote counts and cast votes
// ============================================================================
// GET  ?contentId=...&contentType=... → { counts, votedFor }
// POST { contentId, contentType, votedFor } → { success: true }
//
// Voters are identified by Supabase auth (logged in) or x-session-id header.
// One vote per viewer per piece of content.
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

interface VoteRow {
  voted_for: string;
  voter_user_id: string | null;
  voter_session_id: string | null;
}

async function getVoter(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  const sessionId = request.headers.get('x-session-id');
  return { supabase, userId: user?.id ?? null, sessionId };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const contentId = searchParams.get('contentId');
  const contentType = searchParams.get('contentType');

  if (!contentId || !contentType) {
    return Response.json({ error: 'contentId and contentType are required' }, { status: 400 });
  }

  const { supabase, userId, sessionId } = await getVoter(request);

  const { data, error } = await supabase
    .from('votes')
    .select('voted_for, voter_user_id, voter_session_id')
    .eq('content_id', contentId)
    .eq('content_type', contentType);

  if (error) {
    console.error('[VOTES GET] Failed to load votes:', error);
    return Response.json({ error: 'Failed to load votes', detail: error.message }, { status: 500 });
  }

  // Aggregate counts and find this viewer's vote
  const counts: Record<string, number> = {};
  let votedFor: string | null = null;

  for (const row of (data as VoteRow[]) || []) {
    counts[row.voted_for] = (counts[row.voted_for] || 0) + 1;
    if (
      (userId && row.voter_user_id === userId) ||
      (!userId && sessionId && row.voter_session_id === sessionId)
    ) {
      votedFor = row.voted_for;
    }
  }

  return Response.json({ counts, votedFor });
}

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    contentId?: string;
    contentType?: string;
    votedFor?: string;
  };
  const { contentId, contentType, votedFor } = body;

  if (!contentId || !contentType || votedFor === undefined || votedFor === null) {
    return Response.json({ error: 'contentId, contentType, and votedFor are required' }, { status: 400 });
  }

  const { supabase, userId, sessionId } = await getVoter(request);

  if (!userId && !sessionId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const { data: success, error } = await supabase.rpc('cast_vote', {
    p_content_id: contentId,
    p_content_type: contentType,
    p_user_id: userId,
    p_session_id: userId ? null : sessionId,
    p_voted_for: String(votedFor),
  });

  if (error) {
    console.error('[VOTES POST] Failed to cast vote:', error);
    return Response.json({ error: 'Failed to cast vote', detail: error.message }, { status: 500 });
  }

  if (success === false) {
    return Response.json({ error: 'Already voted' }, { status: 409 });
  }

  return Response.json({ success: true });
}
