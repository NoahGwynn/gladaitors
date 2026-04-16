// ============================================================================
// POST /api/daily/sessions/[id]/turns/[index]/rerun
// ============================================================================
// Operator action: regenerate a single flagged turn so it keeps the
// same substance but addresses the screening findings (e.g. "remove
// the defamatory phrasing", "replace the unsourced claim", "soften
// the loaded language"). Persists the new text into
// debate_snapshot.turns[idx].text and records the original under
// turn_decisions[idx].originalText so the operator can revert.
//
// If this rerun resolves all outstanding critical findings on the
// session, status flips from 'held_for_moderation' → 'completed'.
//
// Caveats:
//   - Only the one turn is rephrased. Subsequent turns may quote it;
//     those are not retroactively updated. The operator should
//     visually check downstream turns after a rerun.
//   - The screening pipeline is NOT re-run on the new text. We trust
//     the rephrase prompt to address the named findings; if the
//     operator wants a re-screen, they can re-trigger it manually.
// ============================================================================

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createServerSupabase } from '@/lib/supabase-server';
import { PRIMARY_SCREENER, callModerationModel } from '@/lib/daily/moderation-pool';
import {
  hasUnresolvedCriticalFindings,
  type TurnDecision,
  type TurnDecisionsMap,
} from '@/lib/daily/turn-flags';
import type { ModerationFinding, ModerationPipelineResult } from '@/lib/daily/moderation-pipeline';

interface Params {
  id: string;
  index: string;
}

interface DebateTurnLite {
  index: number;
  actor: 'moderator' | 'participant';
  text: string;
  modelName?: string;
  seat?: number;
  // Other fields are passed through unchanged.
  [key: string]: unknown;
}

interface DebateSnapshotLite {
  turns: DebateTurnLite[];
  [key: string]: unknown;
}

function buildRephrasePrompt(
  originalText: string,
  findings: ModerationFinding[],
): { system: string; user: string } {
  const system = `You are an editorial reviser for the dAIly. A single message in a debate has been flagged by the screening pipeline. Your job is to rewrite it so it keeps the same substance and stays in the same voice — but resolves the specific issues named below.

RULES
  - Keep the same length and structure as the original. Roughly the same number of sentences. Same overall point.
  - Address EVERY listed finding. Do not leave one unfixed.
  - Do not add caveats, hedges, or apologies that the original didn't have.
  - Do not change what the speaker is arguing. If they were attacking a position, they're still attacking it — just without the legal/factual/bias risk that triggered the flag.
  - If a finding is "this is unsourced", the fix is to soften the claim or attribute it ("according to X", "as reported by Y") — do NOT invent a source.
  - If a finding is "this names an individual in a critical claim", the fix is to remove the name or rephrase to be about the role / institution, not the person.
  - Plain prose. No JSON, no commentary, no preamble. Just the rewritten message text.

OUTPUT
  - Output ONLY the rewritten message body. No labels, no explanation.`;

  const findingsBlock = findings.map((f, i) => {
    const lines = [`${i + 1}. [${f.check}] ${f.issue}`];
    if (f.rationale) lines.push(`   Why: ${f.rationale}`);
    if (f.suggestion) lines.push(`   Suggested fix: ${f.suggestion}`);
    return lines.join('\n');
  }).join('\n\n');

  const user = `ORIGINAL MESSAGE:
"""
${originalText}
"""

FINDINGS TO ADDRESS:
${findingsBlock}

Rewrite the message above to address every finding. Return only the rewritten text.`;

  return { system, user };
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

  const { data: session, error: fetchErr } = await supabase
    .from('forum_sessions')
    .select('id, status, moderation_snapshot, turn_decisions, debate_snapshot')
    .eq('id', id)
    .single();
  if (fetchErr || !session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const snapshot = session.debate_snapshot as DebateSnapshotLite | null;
  const turn = snapshot?.turns?.find(t => t.index === turnIndex);
  if (!snapshot || !turn) {
    return Response.json({ error: 'Turn not found in snapshot' }, { status: 404 });
  }

  // Gather the critical findings bound to this turn so the rephrase
  // prompt knows what to fix.
  const moderation = session.moderation_snapshot as ModerationPipelineResult | null;
  const turnFindings: ModerationFinding[] = [];
  if (moderation) {
    for (const check of moderation.checks) {
      for (const f of check.findings) {
        if (f.severity === 'critical' && f.turnIndex === turnIndex) turnFindings.push(f);
      }
    }
  }
  if (turnFindings.length === 0) {
    return Response.json({ error: 'No critical findings on this turn' }, { status: 400 });
  }

  const originalText = turn.text;
  const { system, user } = buildRephrasePrompt(originalText, turnFindings);

  let rewrittenText: string;
  try {
    rewrittenText = (await callModerationModel(PRIMARY_SCREENER, system, user, 4000)).trim();
  } catch (err) {
    console.error('[ADMIN RERUN] rephrase call failed:', err);
    return Response.json({
      error: err instanceof Error ? err.message : 'Rephrase call failed',
    }, { status: 502 });
  }

  if (!rewrittenText || rewrittenText.length < 10) {
    return Response.json({ error: 'Rephrase returned empty / too short text' }, { status: 502 });
  }

  // Strip surrounding quotes if the model echoed them despite the
  // "no commentary" instruction. Defensive only — the prompt asks for
  // bare text.
  if (rewrittenText.startsWith('"') && rewrittenText.endsWith('"')) {
    rewrittenText = rewrittenText.slice(1, -1).trim();
  }

  // Persist: replace turn text in debate_snapshot, record decision.
  const updatedTurns = snapshot.turns.map(t =>
    t.index === turnIndex ? { ...t, text: rewrittenText } : t,
  );
  const updatedSnapshot = { ...snapshot, turns: updatedTurns };

  const decisions: TurnDecisionsMap = (session.turn_decisions || {}) as TurnDecisionsMap;
  const decision: TurnDecision = {
    action: 'rerun',
    byUserId: admin.id,
    atIso: new Date().toISOString(),
    originalText,
  };
  decisions[String(turnIndex)] = decision;

  const stillUnresolved = hasUnresolvedCriticalFindings(moderation, decisions);
  const nextStatus = !stillUnresolved && session.status === 'held_for_moderation'
    ? 'completed'
    : session.status;

  const update: Record<string, unknown> = {
    debate_snapshot: updatedSnapshot,
    turn_decisions: decisions,
  };
  if (nextStatus !== session.status) update.status = nextStatus;

  const { error: updateErr } = await supabase
    .from('forum_sessions')
    .update(update)
    .eq('id', id);
  if (updateErr) {
    console.error('[ADMIN RERUN] update failed:', updateErr);
    return Response.json({ error: 'Failed to persist rephrase' }, { status: 500 });
  }

  return Response.json({
    success: true,
    decision,
    rewrittenText,
    sessionStatus: nextStatus,
    autoPublished: nextStatus === 'completed' && session.status === 'held_for_moderation',
  });
}
