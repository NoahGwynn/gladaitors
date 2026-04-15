// ============================================================================
// the dAIly — Thread Matching
// ============================================================================
// Clusters ingested items into threads using embedding similarity.
// Each item's embedding is compared against existing threads' aggregate
// embeddings. If similarity exceeds the threshold, the item joins that
// thread. Otherwise, a new thread is created.
//
// Threads are the core data model — the organizers, pool, and moderator
// always work with threads, never raw items.
//
// Uses pgvector's cosine distance operator (<=>). Lower distance =
// higher similarity. cosine_distance = 1 - cosine_similarity, so
// threshold 0.80 similarity = 0.20 max distance.
// ============================================================================

import { createClient } from '@/lib/supabase';

/** Similarity threshold for matching items to threads.
 *  0.80 cosine similarity = 0.20 cosine distance.
 *  Start here, tune during Phase A based on merge quality. */
const SIMILARITY_THRESHOLD = 0.20; // cosine DISTANCE (1 - similarity)

/** Days without new events before a thread goes dormant. */
const DORMANT_AFTER_DAYS = 14;

interface MatchResult {
  itemsProcessed: number;
  matchedToExisting: number;
  newThreadsCreated: number;
  dormantRevived: number;
  errors: string[];
}

/** Match all unthreaded items (items with embeddings but no thread_id)
 *  to existing threads or create new ones. */
export async function matchItemsToThreads(): Promise<MatchResult> {
  const result: MatchResult = {
    itemsProcessed: 0,
    matchedToExisting: 0,
    newThreadsCreated: 0,
    dormantRevived: 0,
    errors: [],
  };

  const supabase = createClient();

  // Get all items that have embeddings but no thread
  const { data: items, error: itemsErr } = await supabase
    .from('forum_items')
    .select('id, title, summary, categories, embedding, published_at')
    .not('embedding', 'is', null)
    .is('thread_id', null)
    .order('ingested_at', { ascending: true })
    .limit(500);

  if (itemsErr || !items || items.length === 0) {
    if (itemsErr) result.errors.push(`Failed to load items: ${itemsErr.message}`);
    return result;
  }

  console.log(`[THREAD] ${items.length} items to match`);

  for (const item of items) {
    result.itemsProcessed++;

    try {
      // Find the closest thread using pgvector cosine distance
      // Search active threads first, then dormant
      const { data: matches, error: matchErr } = await supabase
        .rpc('match_thread', {
          query_embedding: item.embedding,
          match_threshold: SIMILARITY_THRESHOLD,
          match_count: 1,
        });

      if (matchErr) {
        // The RPC might not exist yet — fall back to creating new threads
        // until the RPC is set up
        result.errors.push(`match_thread RPC: ${matchErr.message}`);
        await createNewThread(supabase, item, result);
        continue;
      }

      if (matches && matches.length > 0) {
        const match = matches[0];

        // Add item to the matched thread
        await supabase
          .from('forum_items')
          .update({ thread_id: match.id })
          .eq('id', item.id);

        // Update thread metadata
        const categories = mergeCategories(
          match.categories || [],
          item.categories || []
        );

        await supabase
          .from('forum_threads')
          .update({
            item_count: (match.item_count || 0) + 1,
            last_event_at: new Date().toISOString(),
            categories,
            // If the thread was dormant and a new item matched, revive it
            ...(match.status === 'dormant' ? { status: 'revisited' } : {}),
          })
          .eq('id', match.id);

        if (match.status === 'dormant') {
          result.dormantRevived++;
          console.log(`[THREAD] Revived dormant thread: "${match.title}"`);
        }

        result.matchedToExisting++;
      } else {
        // No match — create a new thread
        await createNewThread(supabase, item, result);
      }
    } catch (err) {
      result.errors.push(`Item ${item.id}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  console.log(
    `[THREAD] Done: ${result.matchedToExisting} matched, ${result.newThreadsCreated} new threads, ${result.dormantRevived} revived`
  );

  return result;
}

/** Create a new thread from an unmatched item. */
async function createNewThread(
  supabase: ReturnType<typeof createClient>,
  item: {
    id: string;
    title: string;
    summary: string | null;
    categories: string[];
    embedding: unknown;
    published_at: string | null;
  },
  result: MatchResult,
): Promise<void> {
  const { data: thread, error: threadErr } = await supabase
    .from('forum_threads')
    .insert({
      title: item.title,
      summary: item.summary?.slice(0, 500) || null,
      categories: item.categories || [],
      embedding: item.embedding,
      status: 'new',
      item_count: 1,
      first_seen_at: item.published_at || new Date().toISOString(),
      last_event_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (threadErr || !thread) {
    result.errors.push(`Create thread for "${item.title.slice(0, 50)}": ${threadErr?.message || 'unknown'}`);
    return;
  }

  // Link the item to the new thread
  await supabase
    .from('forum_items')
    .update({ thread_id: thread.id })
    .eq('id', item.id);

  result.newThreadsCreated++;
}

/** Merge two category arrays, deduplicating. */
function mergeCategories(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Mark threads with no new events in DORMANT_AFTER_DAYS as dormant. */
export async function markDormantThreads(): Promise<number> {
  const supabase = createClient();
  const cutoff = new Date(Date.now() - DORMANT_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('forum_threads')
    .update({ status: 'dormant' })
    .in('status', ['new', 'active'])
    .lt('last_event_at', cutoff)
    .select('id');

  if (error) {
    console.error('[THREAD] Failed to mark dormant:', error);
    return 0;
  }

  const count = data?.length || 0;
  if (count > 0) console.log(`[THREAD] Marked ${count} threads as dormant`);
  return count;
}
