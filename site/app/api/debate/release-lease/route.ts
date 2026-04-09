// ============================================================================
// POST /api/debate/release-lease — release a debate driver lease
// ============================================================================
// Called by the orchestrator's beforeunload handler so refreshing or closing
// a tab clears the lease immediately, instead of waiting for the heartbeat
// to go stale (~15s). The browser uses fetch with keepalive: true so the
// request survives the page unload.
//
// Body: { debateId: uuid, tabId: string }
// Returns 204 on success (or any failure — fire-and-forget from the client).
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { debateId?: string; tabId?: string };
    const debateId = body.debateId;
    const tabId = body.tabId;

    if (!debateId || !tabId) {
      return new Response(null, { status: 204 });
    }

    const supabase = await createServerSupabase();
    // Idempotent — release_debate_lease only clears the lease if the caller
    // is currently the holder, so a stale call after takeover is a no-op.
    await supabase.rpc('release_debate_lease', {
      p_debate_id: debateId,
      p_session_id: tabId,
    });
  } catch {
    // Fire-and-forget. Errors don't matter — heartbeat staleness is the
    // backup detection path.
  }
  return new Response(null, { status: 204 });
}
