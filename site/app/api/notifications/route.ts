// ============================================================================
// /api/notifications — list and mark-as-read for in-app notifications
// ============================================================================
// GET  → returns up to 20 most recent notifications for the current user,
//        and the unread count.
// POST → marks notifications as read. Body: { ids?: string[] } — empty/omitted
//        marks ALL of the user's notifications as read.
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export async function GET() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ notifications: [], unreadCount: 0 });
  }

  // Recent notifications (capped) plus the unread count
  const { data: notifications, error } = await supabase
    .from('notifications')
    .select('id, type, content_id, content_type, data, read, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[NOTIFICATIONS GET] error:', error);
    return Response.json({ error: 'Failed to load notifications' }, { status: 500 });
  }

  const unreadCount = (notifications || []).filter(n => !n.read).length;

  return Response.json({
    notifications: notifications || [],
    unreadCount,
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { ids?: string[] };

  let query = supabase
    .from('notifications')
    .update({ read: true })
    .eq('user_id', user.id)
    .eq('read', false);

  // If specific ids provided, mark only those. Otherwise mark all unread.
  if (body.ids && body.ids.length > 0) {
    query = query.in('id', body.ids);
  }

  const { error } = await query;

  if (error) {
    console.error('[NOTIFICATIONS POST] error:', error);
    return Response.json({ error: 'Failed to mark notifications read' }, { status: 500 });
  }

  return Response.json({ success: true });
}
