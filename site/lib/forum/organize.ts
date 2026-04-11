// ============================================================================
// dAIly Forum — Stage 2: Parallel Organizers
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

// --- Types ---

interface ThreadSummary {
  id: string;
  title: string;
  categories: string[];
  itemCount: number;
  firstSeen: string;
  lastEvent: string;
  sources: string[];    // source names that contributed items
  summary: string | null;
}

interface OrganizerShortlistEntry {
  threadId: string;
  threadTitle: string;
  rank: number;
  readyReason: string;    // why this thread is ready for discussion today
  keyQuestions: string[];  // 2-3 unresolved questions worth debating
  significance: string;   // one-line significance assessment
}

interface OrganizerResponse {
  shortlist: OrganizerShortlistEntry[];
  proposedMerges?: { threadA: string; threadB: string; reason: string }[];
  errors: string[];
}

interface MergedShortlistEntry {
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
}

export interface OrganizeResult {
  category: string;
  threadsEvaluated: number;
  organizerAShortlist: number;
  organizerBShortlist: number;
  mergedShortlist: MergedShortlistEntry[];
  proposedMerges: { threadA: string; threadB: string; reason: string }[];
  errors: string[];
}

// --- Build the prompt for organizers ---

function buildOrganizerPrompt(threads: ThreadSummary[], category: string): string {
  const threadList = threads.map((t, i) => {
    const sources = t.sources.length > 0 ? t.sources.join(', ') : 'unknown';
    return `[${i + 1}] ID: ${t.id}
    Title: ${t.title}
    Items: ${t.itemCount} from ${sources}
    First seen: ${t.firstSeen}
    Latest event: ${t.lastEvent}
    Categories: ${t.categories.join(', ')}
    ${t.summary ? `Summary: ${t.summary}` : ''}`;
  }).join('\n\n');

  return `You are an editorial organizer for a daily AI investigation forum. Your job is to evaluate which threads (ongoing stories/narratives) are ready for a structured discussion today.

CATEGORY: ${category}
DATE: ${new Date().toISOString().split('T')[0]}

You are reviewing ${threads.length} active threads — stories that have accumulated events from news sources, research papers, and community discussions over the past week.

THREADS TO EVALUATE:
${threadList}

YOUR TASK:
1. Identify which threads are READY for discussion today. A thread is ready when:
   - It has accumulated enough substance to warrant a structured investigation
   - Multiple sources or perspectives exist on the topic
   - There are genuine unresolved questions or contested claims
   - It is timely — something has happened recently that makes discussion valuable NOW

2. Rank your top 5-10 threads by significance. For each, provide:
   - Why it's ready today (not yesterday, not next week)
   - 2-3 key unresolved questions worth investigating
   - A one-line significance assessment

3. If any threads should be MERGED (they're really the same story from different angles), propose the merge with a reason.

WHAT NOT TO DO:
- Do not pick a single winner. You are producing a shortlist, not a final selection.
- Do not build a debate agenda. That's the moderator's job later.
- Do not take a stance on any thread. You are an editor, not a participant.
- Do not include threads that aren't genuinely ready — a short list of strong candidates is better than a long list of weak ones.

Respond with JSON:
{
  "shortlist": [
    {
      "threadId": "<thread UUID>",
      "threadTitle": "<thread title>",
      "rank": 1,
      "readyReason": "<why this thread is ready for discussion today>",
      "keyQuestions": ["<question 1>", "<question 2>"],
      "significance": "<one-line significance>"
    }
  ],
  "proposedMerges": [
    {
      "threadA": "<thread UUID>",
      "threadB": "<thread UUID>",
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
      config: { maxOutputTokens: 4000 },
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

    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return {
      shortlist: (parsed.shortlist || []).map((e: Record<string, unknown>, i: number) => ({
        threadId: (e.threadId || e.thread_id || '') as string,
        threadTitle: (e.threadTitle || e.thread_title || '') as string,
        rank: (e.rank as number) || i + 1,
        readyReason: (e.readyReason || e.ready_reason || '') as string,
        keyQuestions: (e.keyQuestions || e.key_questions || []) as string[],
        significance: (e.significance || '') as string,
      })),
      proposedMerges: (parsed.proposedMerges || parsed.proposed_merges || []).map(
        (m: Record<string, unknown>) => ({
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
): { merged: MergedShortlistEntry[]; proposedMerges: { threadA: string; threadB: string; reason: string }[] } {
  const byThread = new Map<string, MergedShortlistEntry>();

  // Process organizer A
  for (const entry of responseA.shortlist) {
    byThread.set(entry.threadId, {
      threadId: entry.threadId,
      threadTitle: entry.threadTitle,
      averageRank: entry.rank,
      organizerAgreement: 1,
      includedBy: ['A'],
      readyReasons: [{ organizer: 'A', reason: entry.readyReason }],
      keyQuestions: [...entry.keyQuestions],
      significance: [entry.significance],
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
      byThread.set(entry.threadId, {
        threadId: entry.threadId,
        threadTitle: entry.threadTitle,
        averageRank: entry.rank,
        organizerAgreement: 1,
        includedBy: ['B'],
        readyReasons: [{ organizer: 'B', reason: entry.readyReason }],
        keyQuestions: [...entry.keyQuestions],
        significance: [entry.significance],
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
 *  a merged shortlist for the pool broadcast. */
export async function organizeThreads(category: string): Promise<OrganizeResult> {
  const supabase = createClient();

  // Load active threads with recent activity (last 7 days)
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: threads, error } = await supabase
    .from('forum_threads')
    .select('id, title, categories, summary, status, item_count, first_seen_at, last_event_at')
    .contains('categories', [category])
    .in('status', ['new', 'active', 'ready', 'revisited'])
    .gte('last_event_at', cutoff)
    .order('last_event_at', { ascending: false })
    .limit(100); // cap to keep prompt size manageable

  if (error || !threads) {
    return {
      category,
      threadsEvaluated: 0,
      organizerAShortlist: 0,
      organizerBShortlist: 0,
      mergedShortlist: [],
      proposedMerges: [],
      errors: [`Failed to load threads: ${error?.message || 'no data'}`],
    };
  }

  if (threads.length === 0) {
    return {
      category,
      threadsEvaluated: 0,
      organizerAShortlist: 0,
      organizerBShortlist: 0,
      mergedShortlist: [],
      proposedMerges: [],
      errors: ['No active threads in the last 7 days'],
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
    });
  }

  console.log(`[ORGANIZE] ${category}: ${threadSummaries.length} threads to evaluate`);

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

  // Merge shortlists (identities already anonymised as A and B)
  const { merged, proposedMerges } = mergeShortlists(responseA, responseB);

  const allErrors = [...responseA.errors, ...responseB.errors];

  console.log(`[ORGANIZE] Merged shortlist: ${merged.length} threads (${merged.filter(m => m.organizerAgreement === 2).length} agreed by both)`);

  return {
    category,
    threadsEvaluated: threadSummaries.length,
    organizerAShortlist: responseA.shortlist.length,
    organizerBShortlist: responseB.shortlist.length,
    mergedShortlist: merged,
    proposedMerges,
    errors: allErrors,
  };
}
