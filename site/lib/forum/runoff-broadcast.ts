// ============================================================================
// dAIly Forum — Stage 4a (runoff): Tied-Topic Runoff Broadcast
// ============================================================================
// When the Stage 3 broadcast votes are tied within 10% margin, this
// module re-prompts the same model pool with ONLY the tied topics and
// asks two things:
//
//   1. PICK — choose exactly one topic from the tied set (no ranking)
//   2. URGENCY — rate every tied topic 1-10 on the question:
//      "How strongly do you feel today's session would be incomplete
//       without this topic being covered?"
//
// The pick decides if there's a winner. If picks tie, urgency totals
// break it. If urgency also ties, the acting moderator path takes
// over (handled by moderator-selection.ts).
//
// The runoff prompt does NOT re-collect votes/conflicts/stances —
// those are already on file from the original Stage 3 broadcast.
// This is purely a tiebreaker round.
//
// Reuses the identity anchor from broadcast.ts so models are grounded
// in their own provider during the runoff just as they were in round 1.
// ============================================================================

import { getAvailablePool, getSkippedModels, callPoolModel, type PoolModel } from './model-pool';
import { buildIdentityAnchor } from './broadcast';
import type { MergedShortlistEntry } from './organize';
import type { RunoffPick, RunoffResult } from './topic-selection';

// --- Build the runoff prompt ---

function buildRunoffPrompt(
  tiedShortlist: MergedShortlistEntry[],
  category: string,
  model: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(model)}

You are participating in a runoff round of the dAIly Forum's daily ${category.toUpperCase()} session. The pool's first vote produced a tie between several candidate topics — none was clearly the most important to discuss today.

Your job is to break the tie. You will:

1. PICK exactly one topic from the tied set — the single topic you most want today's session to cover.
2. RATE every tied topic 1-10 on a different dimension: how strongly you feel today's session would be INCOMPLETE without this topic being covered.

The pick is your first preference. The urgency rating captures something different — a topic might not be your top pick but might still be one that would feel like a glaring omission if skipped. Be honest and direct on both. Both are published transparently.`;

  const threadDescriptions = tiedShortlist.map((t, i) => {
    const agreement = t.organizerAgreement === 2
      ? 'Both editorial organizers shortlisted this thread.'
      : 'One editorial organizer shortlisted this thread.';

    const reasons = t.readyReasons
      .map(r => `Organizer ${r.organizer}: ${r.reason}`)
      .join('\n    ');

    const significance = t.significance.join(' ');

    const lines = [
      `THREAD ${i + 1}`,
      `  ID: ${t.threadId}`,
      `  Title: ${t.threadTitle}`,
      `  Agreement: ${agreement}`,
      `  Why shortlisted:`,
      `    ${reasons}`,
      `  Significance: ${significance}`,
    ];

    if (t.isRevisit && t.revisit) {
      const r = t.revisit;
      lines.push(``);
      lines.push(`  *** PREVIOUSLY DISCUSSED ***`);
      lines.push(`  Prior discussion: ${r.priorDiscussionDate.split('T')[0]} (${r.daysSinceDiscussion} days ago)`);
      lines.push(`  Prior conclusion: ${r.priorConclusion ?? '[debate engine not yet implemented — no recorded conclusion]'}`);
      lines.push(`  New material since: ${r.itemsSinceDiscussion} item(s)`);
      if (r.mostRecentNewItem) {
        lines.push(`  Most recent new item: "${r.mostRecentNewItem.title}" (${r.mostRecentNewItem.date.split('T')[0]})`);
      }
    }

    return lines.join('\n');
  }).join('\n\n');

  const user = `These are the threads tied for the top vote in today's ${category.toUpperCase()} session. The pool needs to pick one.

${threadDescriptions}

Your task:

1. PICK: Choose exactly ONE thread ID from the list above. This is the topic you most want today's session to cover.

2. URGENCY: For EACH tied topic above (not just your pick), rate 1-10 how strongly you feel today's session would be incomplete without this topic being covered.
   1  = the forum can easily skip this and lose nothing important
   5  = it would be a noticeable omission
   10 = the session is fundamentally incomplete without it

   Rate every topic, including the one you picked.

Respond with JSON only. Use the full thread ID from the ID field above for both "pick" and the "urgency" keys.

{
  "pick": "<full UUID of your chosen thread>",
  "urgency": {
    "<full UUID of thread 1>": 7,
    "<full UUID of thread 2>": 5
  }
}`;

  return { system, user };
}

// --- Parse a runoff response ---

function parseRunoffResponse(raw: string): { pick: string | null; urgency: Record<string, number> } {
  const empty = { pick: null as string | null, urgency: {} as Record<string, number> };

  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return empty;

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const pick = typeof parsed.pick === 'string' ? parsed.pick : null;

    const urgencyRaw = (parsed.urgency || {}) as Record<string, unknown>;
    const urgency: Record<string, number> = {};
    for (const [key, val] of Object.entries(urgencyRaw)) {
      const num = typeof val === 'number' ? val : Number(val);
      if (!Number.isNaN(num) && Number.isFinite(num)) {
        // Clamp to 1-10
        urgency[key] = Math.max(1, Math.min(10, num));
      }
    }

    return { pick, urgency };
  } catch {
    return empty;
  }
}

// --- Main entry point ---

/** Run a runoff broadcast against the same model pool as the original
 *  Stage 3 broadcast. Each model returns a single pick + urgency
 *  ratings on every tied topic. Models without API keys are skipped
 *  gracefully, same as the main broadcast. */
export async function runRunoffBroadcast(
  tiedShortlist: MergedShortlistEntry[],
  category: string,
): Promise<RunoffResult> {
  const available = getAvailablePool();
  const skipped = getSkippedModels();

  const tiedTopicIds = tiedShortlist.map(t => t.threadId);

  if (available.length === 0) {
    return {
      tiedTopicIds,
      picks: [],
      errors: ['No models available for runoff — all missing API keys'],
    };
  }

  console.log(`[RUNOFF] Sending ${tiedShortlist.length} tied topics to ${available.length} models`);
  if (skipped.length > 0) {
    console.log(`[RUNOFF] Skipping ${skipped.length} models (no API key)`);
  }

  // Call all available models in parallel
  const promises = available.map(async (model): Promise<RunoffPick> => {
    console.log(`[RUNOFF] Calling ${model.displayName}...`);

    const { system, user } = buildRunoffPrompt(tiedShortlist, category, model);

    try {
      const raw = await callPoolModel(model, system, user, 4000);
      const parsed = parseRunoffResponse(raw);

      console.log(`[RUNOFF] ${model.displayName}: pick=${parsed.pick?.slice(0, 8) || 'none'}, urgency keys=${Object.keys(parsed.urgency).length}`);

      return {
        modelId: model.id,
        modelName: model.displayName,
        pick: parsed.pick,
        urgency: parsed.urgency,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`[RUNOFF] ${model.displayName} failed: ${msg}`);
      return {
        modelId: model.id,
        modelName: model.displayName,
        pick: null,
        urgency: {},
        error: msg,
      };
    }
  });

  const picks = await Promise.all(promises);

  const errors = picks.filter(p => p.error).map(p => `${p.modelName}: ${p.error}`);
  console.log(`[RUNOFF] Done: ${picks.filter(p => !p.error).length} responded, ${picks.filter(p => p.error).length} failed`);

  return {
    tiedTopicIds,
    picks,
    errors,
  };
}
