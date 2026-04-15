// ============================================================================
// the dAIly — Thread Merging
// ============================================================================
// Applies thread merges proposed by both organizers (high confidence).
// The survivor thread absorbs the merged thread's items, categories,
// and metadata. The merged thread is marked 'merged' with a pointer
// to the survivor.
//
// Single-organizer merge suggestions are NOT applied here — they're
// passed through to the pool broadcast as notes.
// ============================================================================

import { createClient } from '@/lib/supabase';

interface MergeProposal {
  threadA: string;
  threadB: string;
  reason: string;
}

interface MergeResult {
  applied: number;
  skipped: number;
  details: { survivor: string; merged: string; reason: string }[];
  errors: string[];
}

/** Find merge proposals that both organizers agree on.
 *  A merge is "agreed" if both organizers proposed merging the same
 *  pair of threads (in either direction — A→B is the same as B→A). */
export function findAgreedMerges(
  proposalsA: MergeProposal[],
  proposalsB: MergeProposal[],
): MergeProposal[] {
  const agreed: MergeProposal[] = [];

  // Normalise each proposal to a sorted pair for direction-independent matching
  const keyOf = (p: MergeProposal) => {
    const sorted = [p.threadA, p.threadB].sort();
    return `${sorted[0]}::${sorted[1]}`;
  };

  const bKeys = new Set(proposalsB.map(keyOf));

  for (const p of proposalsA) {
    if (bKeys.has(keyOf(p))) {
      agreed.push(p);
    }
  }

  return agreed;
}

/** Apply a list of agreed merge proposals. For each:
 *  1. Pick the survivor (thread with more items, or older if tied)
 *  2. Move all items from the merged thread to the survivor
 *  3. Update survivor metadata (categories, item_count, last_event_at)
 *  4. Mark the merged thread as 'merged' */
export async function applyMerges(merges: MergeProposal[]): Promise<MergeResult> {
  const result: MergeResult = {
    applied: 0,
    skipped: 0,
    details: [],
    errors: [],
  };

  if (merges.length === 0) return result;

  const supabase = createClient();

  for (const merge of merges) {
    try {
      // Load both threads
      const { data: threads, error: loadErr } = await supabase
        .from('forum_threads')
        .select('id, title, categories, item_count, first_seen_at, last_event_at, status')
        .in('id', [merge.threadA, merge.threadB]);

      if (loadErr || !threads || threads.length < 2) {
        // One or both threads don't exist — skip
        result.skipped++;
        continue;
      }

      // Skip if either thread is already merged or discussed
      if (threads.some(t => t.status === 'merged' || t.status === 'discussed')) {
        result.skipped++;
        continue;
      }

      const threadA = threads.find(t => t.id === merge.threadA)!;
      const threadB = threads.find(t => t.id === merge.threadB)!;

      // Pick survivor: more items wins, tie goes to older thread
      let survivor = threadA;
      let absorbed = threadB;
      if (threadB.item_count > threadA.item_count ||
          (threadB.item_count === threadA.item_count &&
           threadB.first_seen_at < threadA.first_seen_at)) {
        survivor = threadB;
        absorbed = threadA;
      }

      // Move all items from absorbed → survivor
      const { error: moveErr } = await supabase
        .from('forum_items')
        .update({ thread_id: survivor.id })
        .eq('thread_id', absorbed.id);

      if (moveErr) {
        result.errors.push(`Move items ${absorbed.id} → ${survivor.id}: ${moveErr.message}`);
        continue;
      }

      // Count total items after merge
      const { count } = await supabase
        .from('forum_items')
        .select('id', { count: 'exact', head: true })
        .eq('thread_id', survivor.id);

      // Merge categories (union)
      const mergedCategories = [...new Set([
        ...(survivor.categories || []),
        ...(absorbed.categories || []),
      ])];

      // Update survivor metadata
      const latestEvent = survivor.last_event_at > absorbed.last_event_at
        ? survivor.last_event_at : absorbed.last_event_at;

      await supabase
        .from('forum_threads')
        .update({
          item_count: count || survivor.item_count + absorbed.item_count,
          categories: mergedCategories,
          last_event_at: latestEvent,
        })
        .eq('id', survivor.id);

      // Mark absorbed thread as merged
      await supabase
        .from('forum_threads')
        .update({
          status: 'merged',
          summary: `Merged into thread ${survivor.id}: ${survivor.title}`,
        })
        .eq('id', absorbed.id);

      result.applied++;
      result.details.push({
        survivor: `${survivor.title} (${survivor.id})`,
        merged: `${absorbed.title} (${absorbed.id})`,
        reason: merge.reason,
      });

      console.log(`[MERGE] "${absorbed.title}" → "${survivor.title}" (${merge.reason.slice(0, 80)})`);

    } catch (err) {
      result.errors.push(`${merge.threadA} + ${merge.threadB}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  return result;
}
