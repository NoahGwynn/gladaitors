// ============================================================================
// the dAIly — Stage 2: Parallel Organizers
// ============================================================================
// Two models (Sonnet + Gemini Flash) independently evaluate active
// threads and produce shortlists of threads ready for discussion today.
// Their outputs are merged: agreements get high confidence, divergences
// are flagged for the pool to resolve.
//
// IMPORTANT: organizer identities are stripped before the merged output
// is sent to the pool broadcast in Stage 3. The pool sees "Organizer A"
// and "Organizer B", not "Sonnet" and "Gemini". This prevents models
// from weighting editorial opinions based on who said them.
//
// Per Notion Data Pipeline doc: organizers evaluate, rank, and propose
// merges — they do NOT pick the final topic, build agendas, or take
// stances.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@/lib/supabase';
import { findAgreedMerges, applyMerges } from './thread-merge';

// --- Lifecycle constants ---

/** Minimum days since a thread was last discussed before it's eligible
 *  for re-shortlisting. Cooldown prevents trivial re-discussion churn. */
const REVISIT_COOLDOWN_DAYS = 7;

// --- Types ---

interface RevisitContext {
  /** When the thread was most recently the topic of a dAIly session */
  priorDiscussionDate: string;
  /** Days since that discussion */
  daysSinceDiscussion: number;
  /** What was concluded last time. Null until Stage 6 (debate engine)
   *  exists and forum_sessions.session_summary gets populated. */
  priorConclusion: string | null;
  /** Items added to this thread since the prior discussion */
  itemsSinceDiscussion: number;
  /** Title and date of the most recent new item (for context) */
  mostRecentNewItem: { title: string; date: string } | null;
}

interface ThreadSummary {
  id: string;
  title: string;
  categories: string[];
  itemCount: number;
  firstSeen: string;
  lastEvent: string;
  sources: string[];    // source names that contributed items
  summary: string | null;
  /** Set when this thread has been discussed before and is being
   *  surfaced as a revisit candidate. Drives the prompt enrichment
   *  and the higher organizer bar. */
  revisit: RevisitContext | null;
}

interface OrganizerShortlistEntry {
  threadId: string;
  threadTitle: string;
  rank: number;
  readyReason: string;    // why this thread is ready for discussion today
  keyQuestions: string[];  // 2-3 unresolved questions worth debating
  significance: string;   // one-line significance assessment
  /** True if the organizer is shortlisting a previously-discussed thread.
   *  The organizer is told to apply a higher bar in this case. */
  isRevisit: boolean;
}

interface OrganizerResponse {
  shortlist: OrganizerShortlistEntry[];
  proposedMerges?: { threadA: string; threadB: string; reason: string }[];
  errors: string[];
}

export interface MergedShortlistEntry {
  threadId: string;
  threadTitle: string;
  /** Average rank across organizers that included this thread */
  averageRank: number;
  /** How many organizers included this thread (1 or 2) */
  organizerAgreement: number;
  /** Which organizers included it — anonymised as 'A' and 'B' */
  includedBy: string[];
  readyReasons: { organizer: string; reason: string }[];
  keyQuestions: string[];
  significance: string[];
  /** True if at least one organizer flagged this as a revisit. The
   *  pool broadcast prompt uses this to surface prior context. */
  isRevisit: boolean;
  /** Prior discussion context, carried through from the thread query
   *  for downstream stages. Populated only when isRevisit is true. */
  revisit: RevisitContext | null;
}

export interface OrganizeResult {
  category: string;
  threadsEvaluated: number;
  /** Of threadsEvaluated, how many were normal active threads */
  activeThreadCount: number;
  /** Of threadsEvaluated, how many were eligible revisit candidates */
  revisitThreadCount: number;
  organizerAShortlist: number;
  organizerBShortlist: number;
  mergedShortlist: MergedShortlistEntry[];
  proposedMerges: { threadA: string; threadB: string; reason: string }[];
  appliedMerges: { applied: number; details: { survivor: string; merged: string; reason: string }[] };
  errors: string[];
}

// --- Build the prompt for organizers ---

function buildOrganizerPrompt(threads: ThreadSummary[], category: string): string {
  const threadList = threads.map((t) => {
    const sources = t.sources.length > 0 ? t.sources.join(', ') : 'unknown';
    const baseLines = [
      `THREAD_ID: ${t.id}`,
      `    Title: ${t.title}`,
      `    Items: ${t.itemCount} from ${sources}`,
      `    First seen: ${t.firstSeen}`,
      `    Latest event: ${t.lastEvent}`,
      `    Categories: ${t.categories.join(', ')}`,
    ];
    if (t.summary) baseLines.push(`    Summary: ${t.summary}`);

    if (t.revisit) {
      const r = t.revisit;
      baseLines.push(``);
      baseLines.push(`    *** PREVIOUSLY DISCUSSED ***`);
      baseLines.push(`    Prior discussion: ${r.priorDiscussionDate.split('T')[0]} (${r.daysSinceDiscussion} days ago)`);
      baseLines.push(`    Prior conclusion: ${r.priorConclusion ?? '[debate engine not yet implemented — no recorded conclusion]'}`);
      baseLines.push(`    New material since: ${r.itemsSinceDiscussion} item(s)`);
      if (r.mostRecentNewItem) {
        baseLines.push(`    Most recent new item: "${r.mostRecentNewItem.title}" (${r.mostRecentNewItem.date.split('T')[0]})`);
      }
      baseLines.push(`    REVISIT BAR: shortlist this only if the new material materially shifts the conversation. Recycling the same story is wasted forum time.`);
    }

    return baseLines.join('\n');
  }).join('\n\n');

  const revisitCount = threads.filter(t => t.revisit).length;
  const activeCount = threads.length - revisitCount;

  return `You are an editorial organizer for a daily AI investigation forum. Your job is to evaluate which threads (ongoing stories/narratives) are ready for a structured discussion today.

CATEGORY: ${category}
DATE: ${new Date().toISOString().split('T')[0]}

You are reviewing ${threads.length} threads: ${activeCount} active stories accumulating over the past week${revisitCount > 0 ? `, plus ${revisitCount} previously-discussed thread(s) that have accumulated new material since their original session` : ''}.

THREADS TO EVALUATE:
${threadList}

YOUR TASK:
1. Identify which threads are READY for discussion today. A thread is ready when:
   - It has accumulated enough substance to warrant a structured investigation
   - Multiple sources or perspectives exist on the topic
   - There are genuine unresolved questions or contested claims
   - It is timely — something has happened recently that makes discussion valuable NOW

2. For PREVIOUSLY DISCUSSED threads marked with *** PREVIOUSLY DISCUSSED ***, apply a HIGHER bar:
   - The new material since the prior discussion must materially shift the conversation — new evidence, a major development, a credible refutation, a policy change. Otherwise the forum is just recycling the same story.
   - Set "isRevisit": true for these in your shortlist, and explain in readyReason exactly what has changed since last time.
   - If the new material does NOT materially shift things, do not shortlist it. Be honest.

3. Rank your top 5-10 threads by significance. For each, provide:
   - Why it's ready today (not yesterday, not next week)
   - 2-3 key unresolved questions worth investigating
   - A one-line significance assessment
   - isRevisit (true if previously discussed, false otherwise)

4. If any threads should be MERGED (they're really the same story from different angles), propose the merge with a reason.

WHAT NOT TO DO:
- Do not pick a single winner. You are producing a shortlist, not a final selection.
- Do not build a debate agenda. That's the moderator's job later.
- Do not take a stance on any thread. You are an editor, not a participant.
- Do not include threads that aren't genuinely ready — a short list of strong candidates is better than a long list of weak ones.
- Do not include a previously-discussed thread unless the new material genuinely justifies revisiting it.

Respond with JSON only. IMPORTANT: "threadId" must be the full UUID from the THREAD_ID field above — not a line number or abbreviation.

{
  "shortlist": [
    {
      "threadId": "<full UUID from THREAD_ID field>",
      "threadTitle": "<thread title>",
      "rank": 1,
      "readyReason": "<why this thread is ready for discussion today>",
      "keyQuestions": ["<question 1>", "<question 2>"],
      "significance": "<one-line significance>",
      "isRevisit": false
    }
  ],
  "proposedMerges": [
    {
      "threadA": "<full UUID>",
      "threadB": "<full UUID>",
      "reason": "<why these should be merged>"
    }
  ]
}`;
}

// --- Call the two organizers ---

async function callSonnet(prompt: string): Promise<OrganizerResponse> {
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    return parseOrganizerResponse(text);
  } catch (err) {
    return { shortlist: [], errors: [`Sonnet: ${err instanceof Error ? err.message : 'unknown'}`] };
  }
}

async function callGemini(prompt: string): Promise<OrganizerResponse> {
  try {
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        // Flash uses thinking tokens from the output budget by default.
        // 16k gives enough room for internal reasoning + the full JSON
        // shortlist. 4k was too tight — Flash ran out before producing output.
        maxOutputTokens: 16000,
      },
    });

    const text = response.text || '';
    return parseOrganizerResponse(text);
  } catch (err) {
    return { shortlist: [], errors: [`Gemini: ${err instanceof Error ? err.message : 'unknown'}`] };
  }
}

function parseOrganizerResponse(raw: string): OrganizerResponse {
  try {
    // Extract JSON from markdown fences if present
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return { shortlist: [], errors: ['No JSON found in response'] };
    }

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);

    // Repair common JSON issues from LLM output:
    // 1. Trailing commas before ] or }
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    // 2. Unescaped newlines inside strings (replace with spaces)
    jsonStr = jsonStr.replace(/(?<=":[ ]*"[^"]*)\n(?=[^"]*")/g, ' ');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // If full parse fails, try to extract just the shortlist array
      const listMatch = jsonStr.match(/"shortlist"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
      if (listMatch) {
        try {
          const shortlistStr = listMatch[1].replace(/,\s*([}\]])/g, '$1');
          const shortlist = JSON.parse(shortlistStr);
          return {
            shortlist: (shortlist || []).map((e: Record<string, unknown>, i: number) => ({
              threadId: (e.threadId || e.thread_id || '') as string,
              threadTitle: (e.threadTitle || e.thread_title || '') as string,
              rank: (e.rank as number) || i + 1,
              readyReason: (e.readyReason || e.ready_reason || '') as string,
              keyQuestions: (e.keyQuestions || e.key_questions || []) as string[],
              significance: (e.significance || '') as string,
              isRevisit: Boolean(e.isRevisit ?? e.is_revisit ?? false),
            })),
            errors: ['Partial parse — extracted shortlist only'],
          };
        } catch {
          return { shortlist: [], errors: ['JSON repair failed on shortlist extraction'] };
        }
      }
      return { shortlist: [], errors: ['JSON parse failed after repair attempts'] };
    }

    const parsed2 = parsed;
    return {
      shortlist: ((parsed2.shortlist || []) as Record<string, unknown>[]).map((e, i) => ({
        threadId: (e.threadId || e.thread_id || '') as string,
        threadTitle: (e.threadTitle || e.thread_title || '') as string,
        rank: (e.rank as number) || i + 1,
        readyReason: (e.readyReason || e.ready_reason || '') as string,
        keyQuestions: (e.keyQuestions || e.key_questions || []) as string[],
        significance: (e.significance || '') as string,
        isRevisit: Boolean(e.isRevisit ?? e.is_revisit ?? false),
      })),
      proposedMerges: ((parsed2.proposedMerges || parsed2.proposed_merges || []) as Record<string, unknown>[]).map(
        (m) => ({
          threadA: (m.threadA || m.thread_a || '') as string,
          threadB: (m.threadB || m.thread_b || '') as string,
          reason: (m.reason || '') as string,
        })
      ),
      errors: [],
    };
  } catch (err) {
    return { shortlist: [], errors: [`Parse error: ${err instanceof Error ? err.message : 'unknown'}`] };
  }
}

// --- Merge the two shortlists ---

function mergeShortlists(
  responseA: OrganizerResponse,
  responseB: OrganizerResponse,
  threadRevisits: Map<string, RevisitContext>,
): { merged: MergedShortlistEntry[]; proposedMerges: { threadA: string; threadB: string; reason: string }[] } {
  const byThread = new Map<string, MergedShortlistEntry>();

  // Process organizer A
  for (const entry of responseA.shortlist) {
    const revisitCtx = threadRevisits.get(entry.threadId) || null;
    byThread.set(entry.threadId, {
      threadId: entry.threadId,
      threadTitle: entry.threadTitle,
      averageRank: entry.rank,
      organizerAgreement: 1,
      includedBy: ['A'],
      readyReasons: [{ organizer: 'A', reason: entry.readyReason }],
      keyQuestions: [...entry.keyQuestions],
      significance: [entry.significance],
      // isRevisit is the source-of-truth thread flag, not the model's
      // self-reported field — models can hallucinate the boolean but the
      // thread either was discussed before or it wasn't.
      isRevisit: revisitCtx !== null,
      revisit: revisitCtx,
    });
  }

  // Process organizer B
  for (const entry of responseB.shortlist) {
    const existing = byThread.get(entry.threadId);
    if (existing) {
      // Both organizers included this thread — high confidence
      existing.averageRank = (existing.averageRank + entry.rank) / 2;
      existing.organizerAgreement = 2;
      existing.includedBy.push('B');
      existing.readyReasons.push({ organizer: 'B', reason: entry.readyReason });
      existing.keyQuestions.push(...entry.keyQuestions.filter(q => !existing.keyQuestions.includes(q)));
      existing.significance.push(entry.significance);
    } else {
      // Only organizer B included this — divergence
      const revisitCtx = threadRevisits.get(entry.threadId) || null;
      byThread.set(entry.threadId, {
        threadId: entry.threadId,
        threadTitle: entry.threadTitle,
        averageRank: entry.rank,
        organizerAgreement: 1,
        includedBy: ['B'],
        readyReasons: [{ organizer: 'B', reason: entry.readyReason }],
        keyQuestions: [...entry.keyQuestions],
        significance: [entry.significance],
        isRevisit: revisitCtx !== null,
        revisit: revisitCtx,
      });
    }
  }

  // Sort: agreement first (both > one), then by average rank
  const merged = Array.from(byThread.values()).sort((a, b) => {
    if (a.organizerAgreement !== b.organizerAgreement) return b.organizerAgreement - a.organizerAgreement;
    return a.averageRank - b.averageRank;
  });

  // Merge proposed merges from both (deduplicated)
  const allMerges = [
    ...(responseA.proposedMerges || []),
    ...(responseB.proposedMerges || []),
  ];

  return { merged, proposedMerges: allMerges };
}

// --- Main entry point ---

/** Run Stage 2: parallel organizers evaluate threads and produce
 *  a merged shortlist for the pool broadcast.
 *
 *  Two queries:
 *  1. ACTIVE threads — status in ('new', 'active') with recent activity.
 *     The standard hot pool.
 *  2. REVISIT candidates — status = 'discussed' where (a) the cooldown
 *     has passed and (b) at least one new item has been ingested since
 *     the prior discussion. The organizer is told to apply a higher bar
 *     for these and explain what new material justifies revisiting.
 */
export async function organizeThreads(category: string): Promise<OrganizeResult> {
  const supabase = createClient();

  const now = Date.now();
  const activeCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const revisitCutoff = new Date(now - REVISIT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Query 1 — active threads (the hot pool)
  const { data: activeThreads, error: activeErr } = await supabase
    .from('forum_threads')
    .select('id, title, categories, summary, status, item_count, first_seen_at, last_event_at, discussed_at')
    .contains('categories', [category])
    .in('status', ['new', 'active'])
    .gte('last_event_at', activeCutoff)
    .order('last_event_at', { ascending: false })
    .limit(100); // cap to keep prompt size manageable

  if (activeErr) {
    return {
      category,
      threadsEvaluated: 0,
      activeThreadCount: 0,
      revisitThreadCount: 0,
      organizerAShortlist: 0,
      organizerBShortlist: 0,
      mergedShortlist: [],
      proposedMerges: [],
      appliedMerges: { applied: 0, details: [] },
      errors: [`Failed to load active threads: ${activeErr.message}`],
    };
  }

  // Query 2 — discussed threads past the cooldown. Eligibility for the
  // freshness check is verified per-thread below (need to count items
  // ingested since discussed_at).
  const { data: discussedCandidates, error: discussedErr } = await supabase
    .from('forum_threads')
    .select('id, title, categories, summary, status, item_count, first_seen_at, last_event_at, discussed_at')
    .contains('categories', [category])
    .eq('status', 'discussed')
    .lt('discussed_at', revisitCutoff)
    .order('last_event_at', { ascending: false })
    .limit(50); // smaller cap — revisits are rarer

  if (discussedErr) {
    console.warn(`[ORGANIZE] Failed to load revisit candidates: ${discussedErr.message}`);
  }

  // Build the revisits-by-thread-id map. For each candidate, count items
  // added since discussed_at — if zero, they're not eligible.
  const threadRevisits = new Map<string, RevisitContext>();
  const eligibleRevisits: typeof activeThreads = [];

  for (const t of discussedCandidates || []) {
    if (!t.discussed_at) continue;

    const { count: newItemCount } = await supabase
      .from('forum_items')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', t.id)
      .gt('ingested_at', t.discussed_at);

    if (!newItemCount || newItemCount === 0) continue;

    // Get the most recent new item for context
    const { data: recentItems } = await supabase
      .from('forum_items')
      .select('title, ingested_at')
      .eq('thread_id', t.id)
      .gt('ingested_at', t.discussed_at)
      .order('ingested_at', { ascending: false })
      .limit(1);

    // TODO: when forum_sessions exists (Stage 4 schema work), join here
    // to fetch the prior session_summary instead of leaving null.
    const priorConclusion: string | null = null;

    const daysSince = Math.floor((now - new Date(t.discussed_at).getTime()) / (24 * 60 * 60 * 1000));

    threadRevisits.set(t.id, {
      priorDiscussionDate: t.discussed_at,
      daysSinceDiscussion: daysSince,
      priorConclusion,
      itemsSinceDiscussion: newItemCount,
      mostRecentNewItem: recentItems && recentItems[0]
        ? { title: recentItems[0].title, date: recentItems[0].ingested_at }
        : null,
    });
    eligibleRevisits.push(t);
  }

  const threads = [...(activeThreads || []), ...eligibleRevisits];

  if (threads.length === 0) {
    return {
      category,
      threadsEvaluated: 0,
      activeThreadCount: 0,
      revisitThreadCount: 0,
      organizerAShortlist: 0,
      organizerBShortlist: 0,
      mergedShortlist: [],
      proposedMerges: [],
      appliedMerges: { applied: 0, details: [] },
      errors: ['No active threads or eligible revisits'],
    };
  }

  // Enrich threads with source names from their items
  const threadSummaries: ThreadSummary[] = [];
  for (const t of threads) {
    const { data: items } = await supabase
      .from('forum_items')
      .select('source_id')
      .eq('thread_id', t.id)
      .limit(20);

    // Get unique source names
    const sourceIds = [...new Set((items || []).map(i => i.source_id))];
    let sourceNames: string[] = [];
    if (sourceIds.length > 0) {
      const { data: sources } = await supabase
        .from('forum_sources')
        .select('name')
        .in('id', sourceIds);
      sourceNames = (sources || []).map(s => s.name);
    }

    threadSummaries.push({
      id: t.id,
      title: t.title,
      categories: t.categories || [],
      itemCount: t.item_count || 0,
      firstSeen: t.first_seen_at,
      lastEvent: t.last_event_at,
      sources: sourceNames,
      summary: t.summary,
      revisit: threadRevisits.get(t.id) || null,
    });
  }

  const revisitCount = threadSummaries.filter(t => t.revisit).length;
  console.log(`[ORGANIZE] ${category}: ${threadSummaries.length} threads to evaluate (${threadSummaries.length - revisitCount} active, ${revisitCount} revisit)`);

  // Build the prompt (same for both organizers)
  const prompt = buildOrganizerPrompt(threadSummaries, category);

  // Run both organizers in parallel
  console.log('[ORGANIZE] Calling Sonnet + Gemini Flash in parallel...');
  const [responseA, responseB] = await Promise.all([
    callSonnet(prompt),
    callGemini(prompt),
  ]);

  console.log(`[ORGANIZE] Organizer A (Sonnet): ${responseA.shortlist.length} threads shortlisted`);
  console.log(`[ORGANIZE] Organizer B (Gemini): ${responseB.shortlist.length} threads shortlisted`);

  // Merge shortlists (identities already anonymised as A and B).
  // Pass the revisits map so merged entries carry the source-of-truth
  // isRevisit flag and the prior context for downstream stages.
  const { merged, proposedMerges } = mergeShortlists(responseA, responseB, threadRevisits);

  const allErrors = [...responseA.errors, ...responseB.errors];

  console.log(`[ORGANIZE] Merged shortlist: ${merged.length} threads (${merged.filter(m => m.organizerAgreement === 2).length} agreed by both)`);

  // Apply merges that both organizers agree on
  const agreedMerges = findAgreedMerges(
    responseA.proposedMerges || [],
    responseB.proposedMerges || [],
  );

  let mergeResult = { applied: 0, details: [] as { survivor: string; merged: string; reason: string }[] };
  if (agreedMerges.length > 0) {
    console.log(`[ORGANIZE] ${agreedMerges.length} merges agreed by both organizers — applying...`);
    const fullMergeResult = await applyMerges(agreedMerges);
    mergeResult = { applied: fullMergeResult.applied, details: fullMergeResult.details };
    allErrors.push(...fullMergeResult.errors);
    console.log(`[ORGANIZE] ${fullMergeResult.applied} merges applied`);
  }

  // Single-organizer merge proposals are NOT applied — passed through
  // as notes for the pool/moderator to consider
  const unappliedMerges = proposedMerges.filter(pm => {
    const key = [pm.threadA, pm.threadB].sort().join('::');
    return !agreedMerges.some(am => {
      const amKey = [am.threadA, am.threadB].sort().join('::');
      return amKey === key;
    });
  });

  return {
    category,
    threadsEvaluated: threadSummaries.length,
    activeThreadCount: threadSummaries.length - revisitCount,
    revisitThreadCount: revisitCount,
    organizerAShortlist: responseA.shortlist.length,
    organizerBShortlist: responseB.shortlist.length,
    mergedShortlist: merged,
    proposedMerges: unappliedMerges,
    appliedMerges: mergeResult,
    errors: allErrors,
  };
}
