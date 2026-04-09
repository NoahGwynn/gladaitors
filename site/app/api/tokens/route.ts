// ============================================================================
// GET /api/tokens — Return current token balance
// ============================================================================
// Checks Supabase auth for logged-in users, or session ID for anonymous.
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const { data } = await supabase.rpc('get_token_balance', { p_user_id: user.id });
    return Response.json({ balance: data ?? 0, source: 'user' });
  }

  // Anonymous — use session ID from header
  const sessionId = request.headers.get('x-session-id');
  if (sessionId) {
    const { data } = await supabase.rpc('get_token_balance', { p_session_id: sessionId });
    return Response.json({ balance: data ?? 0, source: 'session' });
  }

  return Response.json({ balance: 0, source: 'none' });
}
