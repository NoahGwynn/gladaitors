// ============================================================================
// POST /api/debates/[id]/synthesis — generate or fetch decision synthesis
// ============================================================================
// v3 utility pivot (Notion Phase 3).
//
// POST: if the debate doesn't already have a decision_synthesis, run
//       generateDecisionSynthesis() and persist. Idempotent — a second
//       POST just returns the stored synthesis.
//
// Gated by debate ownership:
//   - If owner_only=true, only the creator can trigger generation (RLS)
//   - If is_public=true, only the creator can trigger generation (app
//     check) — we don't want random viewers spending our tokens
// ============================================================================

import { NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';
import { generateDecisionSynthesis, type DecisionSynthesis } from '@/lib/debate-synthesis';
import { getTemplateBySlug } from '@/lib/debate-templates';
import type { DebateArgument } from '@/lib/types';

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  // Fetch the debate. RLS already blocks non-owners of private debates,
  // but we still need the row to check ownership for the app-layer
  // "only the owner spends tokens" rule.
  const { data: debate, error: fetchError } = await supabase
    .from('debates')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !debate) {
    return Response.json({ error: 'Debate not found' }, { status: 404 });
  }

  // Ownership check — only the creator can trigger synthesis
  // generation. Anonymous debate creators can still trigger via
  // session-ID match, which we enforce at the creator_session_id
  // level (the front-end reads the session ID from localStorage and
  // sends it as a header for anonymous flows — for v3 commit 2 we
  // only support the logged-in path).
  if (!user || debate.creator_user_id !== user.id) {
    return Response.json(
      { error: 'Only the debate creator can generate a synthesis' },
      { status: 403 },
    );
  }

  // Debate must be complete before we can synthesise it
  if (!debate.is_complete) {
    return Response.json(
      { error: 'Debate is still in progress — synthesis is only available after completion' },
      { status: 400 },
    );
  }

  // Idempotency: if a synthesis already exists, return it as-is
  if (debate.decision_synthesis) {
    return Response.json({
      synthesis: debate.decision_synthesis as DecisionSynthesis,
      cached: true,
    });
  }

  // Build the input for the generator
  const positions = (debate.positions || {}) as Record<string, string>;
  const models = (debate.models || []) as string[];
  const debateArguments = (debate.arguments || []) as DebateArgument[];

  const template = getTemplateBySlug(debate.template_slug || null);

  try {
    const synthesis = await generateDecisionSynthesis({
      topic: debate.topic,
      context: debate.context || null,
      templateName: template?.name || null,
      debaters: models.map((modelId, i) => ({
        seat: i,
        modelId,
        position: positions[String(i)] || '',
      })),
      debateArguments,
    });

    // Persist
    const { error: updateError } = await supabase
      .from('debates')
      .update({ decision_synthesis: synthesis })
      .eq('id', id);

    if (updateError) {
      console.error('[SYNTHESIS] persist failed:', updateError);
      return Response.json({ error: 'Failed to save synthesis' }, { status: 500 });
    }

    return Response.json({ synthesis, cached: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error('[SYNTHESIS] generation failed:', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
