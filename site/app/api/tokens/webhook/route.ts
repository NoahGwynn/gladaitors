// ============================================================================
// POST /api/tokens/webhook — Stripe webhook handler
// ============================================================================
// Listens for checkout.session.completed events and credits tokens.
// Configure this URL in Stripe Dashboard → Webhooks.
// ============================================================================

import { NextRequest } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// Use admin client (service role) to bypass RLS for token crediting
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing signature', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return new Response('Invalid signature', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id;
    const tokenAmount = parseInt(session.metadata?.token_amount || '0', 10);

    if (userId && tokenAmount > 0) {
      const { error } = await supabaseAdmin.rpc('credit_user_tokens', {
        p_user_id: userId,
        p_amount: tokenAmount,
      });

      if (error) {
        console.error('Failed to credit tokens:', error);
        return new Response('Token credit failed', { status: 500 });
      }

      console.log(`Credited ${tokenAmount} tokens to user ${userId}`);
    }
  }

  return new Response('ok', { status: 200 });
}
