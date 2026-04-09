// ============================================================================
// POST /api/tokens/checkout — Create a Stripe embedded checkout session
// ============================================================================
// Returns a client_secret for the EmbeddedCheckout component.
// User must be logged in to purchase tokens.
// ============================================================================

import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { createServerSupabase } from '@/lib/supabase-server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Token packs — amount in pence (GBP)
const TOKEN_PACKS = {
  50: { price: 100, label: '50 tokens' },
  150: { price: 250, label: '150 tokens' },
  500: { price: 700, label: '500 tokens' },
} as const;

type PackSize = keyof typeof TOKEN_PACKS;

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Sign in to purchase tokens' }, { status: 401 });
  }

  const { pack } = await request.json() as { pack: number };
  const packInfo = TOKEN_PACKS[pack as PackSize];

  if (!packInfo) {
    return Response.json({ error: 'Invalid token pack' }, { status: 400 });
  }

  const origin = request.headers.get('origin') || 'http://localhost:3000';

  const session = await stripe.checkout.sessions.create({
    ui_mode: 'embedded_page',
    mode: 'payment',
    currency: 'gbp',
    customer_email: user.email,
    line_items: [{
      price_data: {
        currency: 'gbp',
        unit_amount: packInfo.price,
        product_data: {
          name: packInfo.label,
          description: `${pack} debate tokens for gladAItors`,
        },
      },
      quantity: 1,
    }],
    metadata: {
      user_id: user.id,
      token_amount: String(pack),
    },
    return_url: `${origin}/arena/debate?checkout=complete`,
  });

  return Response.json({ clientSecret: session.client_secret });
}
