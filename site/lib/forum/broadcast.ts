// ============================================================================
// dAIly Forum — Stage 3: Pool Broadcast (votes-only)
// ============================================================================
// The merged shortlist from Stage 2 goes to every model in the pool.
// Each model returns ONLY a vote — which topics are most important to
// discuss today and why. No stance, no conflict score.
//
// Stance and conflict declarations happen LATER, in the focused
// rebroadcast (Stage 4b, focused-broadcast.ts) after one topic has
// won. Splitting voting from commitment gives models a cleaner
// cognitive task at each step:
//
//   - Stage 3 (this file) — "which of these 8 should we discuss?"
//     A high-level editorial judgement on a list.
//   - Stage 4b (focused-broadcast.ts) — "on THIS one topic: how
//     conflicted are you, are you fit to moderate it, and what's
//     your stance if you're a panelist?" A commitment-level
//     introspection on a single subject.
//
// Historical note: earlier the broadcast did all three jobs in one
// call. Models under-scored their own conflict ("I can handle it")
// and hedged their stances across 8 hypotheticals. Splitting the
// concerns fixed both.
//
// Models are called in parallel. Models without API keys are skipped
// gracefully (logged but not blocking). The broadcast uses FLAGSHIP
// tiers — the same models that will participate in the debate need
// the same depth of reasoning for their votes.
// ============================================================================

import { getAvailablePool, getSkippedModels, callPoolModel, MODEL_POOL, type PoolModel } from './model-pool';
import type { MergedShortlistEntry } from './organize';

// --- Types ---

export interface TopicVote {
  threadId: string;
  /** 1 = top preference, higher = lower preference */
  rank: number;
  voteReason: string;
}

export interface ModelBroadcastResponse {
  modelId: string;
  modelName: string;
  provider: string;
  region: string;
  votes: TopicVote[];
  error?: string;
}

export interface BroadcastResult {
  responses: ModelBroadcastResponse[];
  skippedModels: { id: string; name: string; reason: string }[];
  errors: string[];
}

// --- Identity anchor (shared with runoff-broadcast.ts) ---

/** Build the identity anchor block that goes at the top of every system
 *  prompt sent to a pool model. Tells the model exactly who it is and
 *  who its competitors are so conflict declarations (in the focused
 *  rebroadcast and downstream stages) are grounded correctly. Reused
 *  by every stage that prompts pool models. */
export function buildIdentityAnchor(model: PoolModel): string {
  const competitors = MODEL_POOL
    .filter(m => m.active && m.id !== model.id)
    .map(m => `${m.provider} (${m.family})`)
    .join(', ');

  return `You are ${model.family}, a frontier AI model built by ${model.provider}.

IDENTITY ANCHOR — read carefully before answering anything:
- Your developer / provider is ${model.provider}.
- Your model family is ${model.family}.
- You are NOT built by any other lab. When a topic concerns another lab's model, product, or policy, that is a COMPETITOR, not you.
- The other frontier labs in this forum's pool are: ${competitors}.`;
}

// --- Build the broadcast prompt ---

function buildBroadcastPrompt(
  shortlist: MergedShortlistEntry[],
  category: string,
  model: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(model)}

You are participating in a structured daily investigation forum called dAIly Forum, which examines what frontier AI models actually do when put in structured situations.

Today you are being asked ONE question: which of the shortlisted topics below are most important to discuss today?

This is a voting ballot. You are not being asked for your stance, your conflict of interest, or your position — those come later, once the topic is chosen. Right now your only job is to rank the topics by importance for today's session.

Your votes are published alongside your name and provider, so be honest.`;

  const threadDescriptions = shortlist.map((t, i) => {
    const agreement = t.organizerAgreement === 2
      ? 'Both editorial organizers independently shortlisted this thread.'
      : `One editorial organizer shortlisted this thread (the other did not).`;

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
      lines.push(`  NOTE: When voting, weigh whether the new material justifies revisiting this story or whether the forum should move on.`);
    }

    return lines.join('\n');
  }).join('\n\n');

  const user = `Here are today's shortlisted threads for the ${category.toUpperCase()} category:

${threadDescriptions}

Rank your top choices (1 = most important to discuss today). You don't need to rank all threads — only the ones you think genuinely warrant discussion today. Include a brief reason for each vote so the transparency layer can show why you voted the way you did.

Respond with JSON only. Use the full thread ID from the ID field above.

{
  "votes": [
    { "threadId": "<full UUID>", "rank": 1, "voteReason": "<why this should be discussed today>" }
  ]
}`;

  return { system, user };
}

// --- Parse a model's response ---

function parseBroadcastResponse(raw: string): { votes: TopicVote[] } {
  const empty = { votes: [] };

  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return empty;

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr);

    const votes = ((parsed.votes || []) as Record<string, unknown>[]).map((v, i) => ({
      threadId: (v.threadId || v.thread_id || '') as string,
      rank: (v.rank as number) || i + 1,
      voteReason: (v.voteReason || v.vote_reason || v.reason || '') as string,
    }));

    return { votes };
  } catch {
    return empty;
  }
}

// --- Main entry point ---

/** Run Stage 3: broadcast the shortlist to all available models in
 *  the pool. Each model returns votes only. Models without API keys
 *  are skipped gracefully. */
export async function broadcastToPool(
  shortlist: MergedShortlistEntry[],
  category: string,
): Promise<BroadcastResult> {
  const available = getAvailablePool();
  const skipped = getSkippedModels();

  const result: BroadcastResult = {
    responses: [],
    skippedModels: skipped.map(m => ({
      id: m.id,
      name: m.displayName,
      reason: `No API key (${m.apiKeyEnv})`,
    })),
    errors: [],
  };

  if (available.length === 0) {
    result.errors.push('No models available — all missing API keys');
    return result;
  }

  console.log(`[BROADCAST] Sending shortlist (${shortlist.length} threads) to ${available.length} models for votes-only`);
  if (skipped.length > 0) {
    console.log(`[BROADCAST] Skipping ${skipped.length} models (no API key): ${skipped.map(m => m.displayName).join(', ')}`);
  }

  const promises = available.map(async (model): Promise<ModelBroadcastResponse> => {
    console.log(`[BROADCAST] Calling ${model.displayName}...`);

    const { system, user } = buildBroadcastPrompt(shortlist, category, model);

    try {
      const raw = await callPoolModel(model, system, user, 4000);
      const parsed = parseBroadcastResponse(raw);

      console.log(`[BROADCAST] ${model.displayName}: ${parsed.votes.length} votes`);

      return {
        modelId: model.id,
        modelName: model.displayName,
        provider: model.provider,
        region: model.region,
        votes: parsed.votes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`[BROADCAST] ${model.displayName} failed: ${msg}`);
      return {
        modelId: model.id,
        modelName: model.displayName,
        provider: model.provider,
        region: model.region,
        votes: [],
        error: msg,
      };
    }
  });

  const responses = await Promise.all(promises);
  result.responses = responses;

  const succeeded = responses.filter(r => !r.error).length;
  const failed = responses.filter(r => r.error).length;
  console.log(`[BROADCAST] Done: ${succeeded} responded, ${failed} failed, ${skipped.length} skipped`);

  return result;
}
