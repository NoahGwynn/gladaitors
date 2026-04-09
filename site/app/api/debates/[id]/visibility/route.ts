// ============================================================================
// POST /api/debates/[id]/visibility — toggle a debate's public listing
// ============================================================================
// Owner-only. Anonymous debates cannot be made public (they expire in 30 days).
// Body: { public: boolean }
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { public?: boolean };

  if (typeof body.public !== 'boolean') {
    return Response.json({ error: 'Body must include { public: boolean }' }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Sign in to change visibility' }, { status: 401 });
  }

  // Check ownership. Only registered creators can list debates publicly —
  // anonymous debates expire in 30 days and shouldn't appear in the feed.
  const { data: debate, error: fetchError } = await supabase
    .from('debates')
    .select('creator_user_id, is_complete')
    .eq('id', id)
    .single();

  if (fetchError || !debate) {
    return Response.json({ error: 'Debate not found' }, { status: 404 });
  }

  if (!debate.creator_user_id || debate.creator_user_id !== user.id) {
    return Response.json({ error: 'You do not own this debate' }, { status: 403 });
  }

  if (!debate.is_complete) {
    return Response.json({ error: 'Only completed debates can be listed' }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from('debates')
    .update({ is_public: body.public })
    .eq('id', id);

  if (updateError) {
    console.error('[VISIBILITY] update failed:', updateError);
    return Response.json({ error: 'Failed to update visibility' }, { status: 500 });
  }

  return Response.json({ success: true, isPublic: body.public });
}
