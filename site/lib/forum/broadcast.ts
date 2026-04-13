// ============================================================================
// dAIly Forum — Stage 3: Pool Broadcast
// ============================================================================
// The merged shortlist from Stage 2 goes to every model in the pool.
// Each model returns a combined response: topic vote, conflict
// declaration, and provisional stance — all in one call.
//
// Models are called in parallel. Models without API keys are skipped
// gracefully (logged but not blocking). The broadcast uses FLAGSHIP
// tiers — the same models that will participate in the debate need
// the same depth of reasoning for their stance declarations.
//
// The response data feeds directly into Stage 4 (moderator assignment)
// and Stage 5 (cast selection) without a second broadcast round.
//
// Per user decision: models see the organizer ready-reasons and
// significance assessments (why a thread was shortlisted) but NOT
// the organizers' suggested key questions (those would pre-frame
// thinking before the moderator builds the actual agenda).
// ============================================================================

import { getAvailablePool, getSkippedModels, callPoolModel, MODEL_POOL, type PoolModel } from './model-pool';
import type { MergedShortlistEntry } from './organize';

// --- Types ---

export interface ConflictDeclaration {
  threadId: string;
  /** 0 = no conflict, 100 = deeply personal stake */
  conflictScore: number;
  conflictReason: string;
}

export interface StanceDeclaration {
  threadId: string;
  stance: string;
}

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
  conflicts: ConflictDeclaration[];
  stances: StanceDeclaration[];
  error?: string;
}

export interface BroadcastResult {
  responses: ModelBroadcastResponse[];
  skippedModels: { id: string; name: string; reason: string }[];
  errors: string[];
}

// --- Build the broadcast prompt ---

function buildBroadcastPrompt(
  shortlist: MergedShortlistEntry[],
  category: string,
  model: PoolModel,
): { system: string; user: string } {
  // Build a list of the other labs in the pool so the model knows
  // who its competitors are when assessing conflict of interest.
  const competitors = MODEL_POOL
    .filter(m => m.active && m.id !== model.id)
    .map(m => `${m.provider} (${m.family})`)
    .join(', ');

  const system = `You are ${model.family}, a frontier AI model built by ${model.provider}. You are participating in a structured daily investigation forum called dAIly Forum, which examines what frontier AI models actually do when put in structured situations.

IDENTITY ANCHOR — read carefully before answering anything:
- Your developer / provider is ${model.provider}.
- Your model family is ${model.family}.
- You are NOT built by any other lab. When a topic concerns another lab's model, product, or policy, that is a COMPETITOR, not you.
- The other frontier labs in this forum's pool are: ${competitors}.

Today you are being asked to review a shortlist of candidate topics for the ${category.toUpperCase()} category and provide three things:

1. TOPIC VOTE — rank which topics you think are most important to discuss today
2. CONFLICT DECLARATION — for each topic, declare whether you have a personal conflict of interest (0-100 scale)
3. STANCE — for each topic, if you were a participant in the discussion, what position would you take?

Be honest in all three. Your conflict declaration affects whether you can moderate today's session. Your stance helps the moderator cast the right participants. Both are published transparently alongside your name and provider, so getting your own identity wrong will be visible to readers.`;

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

    // If this thread has been the topic of a prior session, the
    // organizers shortlisted it because new material emerged. The pool
    // needs to know that — both to weigh whether re-discussion is
    // warranted, and to avoid voting blind on something that's been
    // covered. The organizer's readyReason already explains what's
    // changed; this section provides the raw facts.
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

For each thread, provide:

1. VOTE: Rank your top choices (1 = most important to discuss today). You don't need to rank all threads — only the ones you think genuinely warrant discussion. Include a brief reason for each vote.

2. CONFLICT: Rate 0-100 how personally conflicted you are on each thread. Remember: you are ${model.family} from ${model.provider}. Only score based on YOUR lab, not anyone else's.
   0    = completely neutral, no stake whatsoever — e.g. a topic about a competitor lab's product that has no bearing on ${model.provider}
   20-40 = the topic affects the broader frontier AI industry or a competitor, and ${model.provider}'s position is indirectly relevant, but I can discuss it fairly
   50-70 = the topic touches ${model.provider}'s policies, products, or strategic interests directly, but is not literally about me
   80-100 = the topic is directly about ${model.family}, ${model.provider}, or my own direct capabilities and behaviour
   Be specific about WHY you have a conflict if your score is above 0. Do NOT claim ownership of another lab's model — if a thread is about a competitor's product, your conflict should be low or zero unless ${model.provider} is also implicated.

3. STANCE: For each thread, if you were selected as a participant, what position would you argue? One to two sentences. This should be your genuine first read, not a hedged non-answer.

Respond with JSON only. Use the full thread ID from the ID field above.

{
  "votes": [
    { "threadId": "<full UUID>", "rank": 1, "voteReason": "<why this should be discussed today>" }
  ],
  "conflicts": [
    { "threadId": "<full UUID>", "conflictScore": 0, "conflictReason": "<why or why not>" }
  ],
  "stances": [
    { "threadId": "<full UUID>", "stance": "<your position if you were a participant>" }
  ]
}`;

  return { system, user };
}

// --- Parse a model's response ---

function parseBroadcastResponse(raw: string): {
  votes: TopicVote[];
  conflicts: ConflictDeclaration[];
  stances: StanceDeclaration[];
} {
  const empty = { votes: [], conflicts: [], stances: [] };

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

    const conflicts = ((parsed.conflicts || []) as Record<string, unknown>[]).map(c => ({
      threadId: (c.threadId || c.thread_id || '') as string,
      conflictScore: (c.conflictScore || c.conflict_score || c.score || 0) as number,
      conflictReason: (c.conflictReason || c.conflict_reason || c.reason || '') as string,
    }));

    const stances = ((parsed.stances || []) as Record<string, unknown>[]).map(s => ({
      threadId: (s.threadId || s.thread_id || '') as string,
      stance: (s.stance || s.position || '') as string,
    }));

    return { votes, conflicts, stances };
  } catch {
    return empty;
  }
}

// --- Main entry point ---

/** Run Stage 3: broadcast the shortlist to all available models in
 *  the pool. Each model returns votes, conflicts, and stances in
 *  a single call. Models without API keys are skipped gracefully. */
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

  console.log(`[BROADCAST] Sending shortlist (${shortlist.length} threads) to ${available.length} models`);
  if (skipped.length > 0) {
    console.log(`[BROADCAST] Skipping ${skipped.length} models (no API key): ${skipped.map(m => m.displayName).join(', ')}`);
  }

  // Call all available models in parallel. Each model gets a prompt
  // that anchors it in its own identity so conflict declarations are
  // grounded correctly.
  const promises = available.map(async (model): Promise<ModelBroadcastResponse> => {
    console.log(`[BROADCAST] Calling ${model.displayName}...`);

    const { system, user } = buildBroadcastPrompt(shortlist, category, model);

    try {
      const raw = await callPoolModel(model, system, user, 8000);
      const parsed = parseBroadcastResponse(raw);

      console.log(`[BROADCAST] ${model.displayName}: ${parsed.votes.length} votes, ${parsed.conflicts.length} conflicts, ${parsed.stances.length} stances`);

      return {
        modelId: model.id,
        modelName: model.displayName,
        provider: model.provider,
        region: model.region,
        ...parsed,
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
        conflicts: [],
        stances: [],
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
