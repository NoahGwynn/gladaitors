// ============================================================================
// GET /api/debates/public — public feed of opted-in debates
// ============================================================================
// Query params:
//   sort  — 'recent' (default) | 'votes' | 'views'
//   limit — default 20, max 50
//   offset — default 0
// No auth required.
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sort = searchParams.get('sort') || 'recent';
  const limit = Math.min(Number(searchParams.get('limit') || '20'), 50);
  const offset = Math.max(Number(searchParams.get('offset') || '0'), 0);

  const supabase = await createServerSupabase();

  // Pull the public debates with everything we need to render a card.
  // Vote counts come from a separate aggregation since RLS prevents joins
  // through the view; simpler to fetch the debates first then count votes.
  const orderColumn = sort === 'views' ? 'view_count' : 'created_at';
  // 'votes' sort is computed client-side after we fetch counts since we'd
  // need a more complex query to order by vote count at the DB level.
  // For MVP at this scale, fetching ~50 debates and sorting in memory is fine.

  const { data: debates, error } = await supabase
    .from('debates')
    .select('id, topic, models, positions, view_count, created_at, arguments')
    .eq('is_public', true)
    .eq('is_complete', true)
    .order(orderColumn, { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[PUBLIC FEED] error:', error);
    return Response.json({ error: 'Failed to load feed' }, { status: 500 });
  }

  // Get vote counts for these debates in one query
  const ids = (debates || []).map(d => d.id);
  let voteCounts: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: votes } = await supabase
      .from('votes')
      .select('content_id')
      .eq('content_type', 'debate')
      .in('content_id', ids);
    voteCounts = (votes || []).reduce((acc: Record<string, number>, v: { content_id: string }) => {
      acc[v.content_id] = (acc[v.content_id] || 0) + 1;
      return acc;
    }, {});
  }

  // Compute argument counts (so the feed can show debate length) and attach vote counts
  let result = (debates || []).map(d => ({
    id: d.id,
    topic: d.topic,
    models: d.models as string[],
    positions: d.positions as Record<string, string>,
    viewCount: d.view_count as number,
    voteCount: voteCounts[d.id] || 0,
    argumentCount: Array.isArray(d.arguments) ? d.arguments.length : 0,
    createdAt: d.created_at as string,
  }));

  // If sorting by votes, sort the in-memory result
  if (sort === 'votes') {
    result = result.sort((a, b) => b.voteCount - a.voteCount);
  }

  return Response.json({ debates: result });
}
