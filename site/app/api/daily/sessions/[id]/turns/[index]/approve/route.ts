// ============================================================================
// POST /api/daily/sessions/[id]/turns/[index]/approve
// ============================================================================
// Operator action: dismiss the moderation findings on a single turn
// without changing the turn's text. Records who approved it and when
// in forum_sessions.turn_decisions[<index>]. If approving this turn
// resolves all outstanding critical findings on the session, also
// flips status from 'held_for_moderation' → 'completed' so the
// session publishes.
//
// Admin-only via lib/admin.ts. The screening pipeline's findings
// stay in moderation_snapshot for audit; the decision record sits
// alongside as the operator's response.
// ============================================================================

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createServerSupabase } from '@/lib/supabase-server';
import {
  hasUnresolvedCriticalFindings,
  type TurnDecision,
  type TurnDecisionsMap,
} from '@/lib/daily/turn-flags';

interface Params {
  id: string;
  index: string;
}

export async function POST(_request: NextRequest, { params }: { params: Promise<Params> }) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const admin = guard;

  const { id, index } = await params;
  const turnIndex = Number.parseInt(index, 10);
  if (!Number.isFinite(turnIndex) || turnIndex < 0) {
    return Response.json({ error: 'Invalid turn index' }, { status: 400 });
  }

  const supabase = await createServerSupabase();

  // Pull the row so we can merge into existing turn_decisions and
  // recompute the auto-publish trigger. Service-role would skip RLS,
  // but we already gated on admin status — reading via the user's
  // session is fine.
  const { data: session, error: fetchErr } = await supabase
    .from('forum_sessions')
    .select('id, status, moderation_snapshot, turn_decisions')
    .eq('id', id)
    .single();
  if (fetchErr || !session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const decisions: TurnDecisionsMap = (session.turn_decisions || {}) as TurnDecisionsMap;
  const decision: TurnDecision = {
    action: 'approved',
    byUserId: admin.id,
    atIso: new Date().toISOString(),
  };
  decisions[String(turnIndex)] = decision;

  // Auto-publish check: if this approval clears the last unresolved
  // critical finding, flip the session to 'completed'. Otherwise just
  // persist the decision and leave the status alone.
  const stillUnresolved = hasUnresolvedCriticalFindings(
    session.moderation_snapshot,
    decisions,
  );
  const nextStatus = !stillUnresolved && session.status === 'held_for_moderation'
    ? 'completed'
    : session.status;

  const update: Record<string, unknown> = { turn_decisions: decisions };
  if (nextStatus !== session.status) update.status = nextStatus;

  const { error: updateErr } = await supabase
    .from('forum_sessions')
    .update(update)
    .eq('id', id);
  if (updateErr) {
    console.error('[ADMIN APPROVE] update failed:', updateErr);
    return Response.json({ error: 'Failed to record approval' }, { status: 500 });
  }

  return Response.json({
    success: true,
    decision,
    sessionStatus: nextStatus,
    autoPublished: nextStatus === 'completed' && session.status === 'held_for_moderation',
  });
}
