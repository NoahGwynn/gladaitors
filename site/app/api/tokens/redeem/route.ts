// ============================================================================
// POST /api/tokens/redeem — Redeem a coupon code for tokens
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Sign in to redeem a code' }, { status: 401 });
  }

  const { code } = await request.json() as { code: string };

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return Response.json({ error: 'Enter a code' }, { status: 400 });
  }

  const { data: tokensAwarded, error } = await supabase.rpc('redeem_coupon', {
    p_user_id: user.id,
    p_code: code,
  });

  if (error) {
    console.error('Coupon redemption error:', error);
    return Response.json({ error: 'Something went wrong' }, { status: 500 });
  }

  if (!tokensAwarded || tokensAwarded === 0) {
    return Response.json({ error: 'Invalid, expired, or already used code' }, { status: 400 });
  }

  return Response.json({ tokens: tokensAwarded });
}
