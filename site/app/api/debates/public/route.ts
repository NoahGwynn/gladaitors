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

  // Build a short preview snippet from the first real (non-moderator,
  // non-refused) argument so the explore card has flavor text.
  function buildPreview(args: unknown): string | null {
    if (!Array.isArray(args) || args.length === 0) return null;
    type A = { content?: string; refused?: boolean; model_id?: string; round?: number };
    // Sort by round so we always pick from round 1 first
    const sorted = (args as A[]).slice().sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    const first = sorted.find(a => !a.refused && a.model_id !== 'moderator' && typeof a.content === 'string' && a.content.trim().length > 0);
    if (!first?.content) return null;
    // Strip basic markdown (bold/italic/code marks) so the preview reads as plain text
    let text = first.content
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 160) {
      // Try to end at a sentence boundary near the cap, else hard cut + ellipsis
      const slice = text.slice(0, 160);
      const lastBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      text = lastBreak > 80 ? slice.slice(0, lastBreak + 1) : slice.trim() + '…';
    }
    return text;
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
    preview: buildPreview(d.arguments),
  }));

  // If sorting by votes, sort the in-memory result
  if (sort === 'votes') {
    result = result.sort((a, b) => b.voteCount - a.voteCount);
  }

  return Response.json({ debates: result });
}
