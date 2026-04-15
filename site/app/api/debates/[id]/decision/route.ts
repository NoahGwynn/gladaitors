// ============================================================================
// POST /api/debates/[id]/decision — save user's decision fields
// ============================================================================
// v3 utility pivot (Notion Phase 3). Saves two optional user-authored
// fields on the debate row:
//
//   whatWouldChangeMyMind — free text. The user's answer to "what
//                           would change your mind about your current
//                           leaning?" Captured to encourage the user
//                           to name their own falsifiability conditions
//                           before they act.
//
//   decision              — structured: { decision, rationale }. An
//                           optional capture of what the user actually
//                           decided after running the debate. Stored
//                           alongside for future reference — a user who
//                           re-runs the same debate in 3 months wants
//                           to compare their new decision to the old.
//
// Both are owner-only. Body is a partial — either field alone, or both
// together. Missing fields are not overwritten.
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

interface Params {
  params: Promise<{ id: string }>;
}

interface UserDecisionPayload {
  decision: string;
  rationale: string;
  timestamp: string;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as {
    whatWouldChangeMyMind?: string;
    decision?: { decision: string; rationale: string };
  };

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Sign in to save decision fields' }, { status: 401 });
  }

  // Ownership check
  const { data: debate, error: fetchError } = await supabase
    .from('debates')
    .select('creator_user_id')
    .eq('id', id)
    .single();

  if (fetchError || !debate) {
    return Response.json({ error: 'Debate not found' }, { status: 404 });
  }

  if (debate.creator_user_id !== user.id) {
    return Response.json({ error: 'You do not own this debate' }, { status: 403 });
  }

  // Build a partial update — only touch fields that were sent
  const update: Record<string, unknown> = {};

  if (typeof body.whatWouldChangeMyMind === 'string') {
    // Trim to a sane cap — this is a free-text field, 4000 chars is
    // more than enough for a reflective prompt response.
    update.what_would_change_my_mind = body.whatWouldChangeMyMind.slice(0, 4000);
  }

  if (body.decision && typeof body.decision.decision === 'string' && typeof body.decision.rationale === 'string') {
    const payload: UserDecisionPayload = {
      decision: body.decision.decision.slice(0, 1000),
      rationale: body.decision.rationale.slice(0, 4000),
      timestamp: new Date().toISOString(),
    };
    update.user_decision = payload;
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from('debates')
    .update(update)
    .eq('id', id);

  if (updateError) {
    console.error('[DECISION] update failed:', updateError);
    return Response.json({ error: 'Failed to save' }, { status: 500 });
  }

  return Response.json({ success: true });
}
