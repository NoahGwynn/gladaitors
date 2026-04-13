// ============================================================================
// dAIly Forum — Tagged Memory Query
// ============================================================================
// Retrieves past utterances from forum_utterances. Used in two places:
//
//   1. Stage 5c (agenda build) — pre-loads relevant past statements per
//      agenda segment so the moderator has them in context at runtime
//      without needing to look them up mid-debate
//
//   2. Stage 6 (debate runtime) — ad-hoc lookups when a participant's
//      response goes in an unexpected direction; the moderator can fetch
//      memory on the fly via the `memory_lookup` move
//
// Lineage queries: passing modelFamily (e.g. "Claude Opus") matches all
// versions in that family, enabling "Claude Opus 4.5 said this; you as
// 4.6 disagree" cross-version contradiction surfacing. modelId is the
// stricter filter — exact same model only.
// ============================================================================

import { createClient } from '@/lib/supabase';

// --- Types ---

export interface MemoryQueryOptions {
  /** Match this exact pool model id (mutually exclusive with modelFamily) */
  modelId?: string;
  /** Match all versions in this family — enables cross-version queries */
  modelFamily?: string;
  /** Required: at least one of these tags must be present on the utterance */
  tags: string[];
  /** Optionally restrict to a category */
  category?: string;
  /** Exclude utterances from these sessions (e.g. the current session) */
  excludeSessionIds?: string[];
  /** Maximum number of hits to return (default 5) */
  limit?: number;
}

export interface MemoryHit {
  id: string;
  sessionId: string;
  category: string;
  segmentName: string | null;
  turnIndex: number;
  participantSeat: number;
  modelId: string;
  modelFamily: string;
  utteranceText: string;
  tags: string[];
  spokenAt: string;
}

// --- Query function ---

/** Query the tagged memory store. Returns past utterances ordered by
 *  most-recent first, filtered by participant identity (model or family)
 *  and tag overlap. Empty array on cold start or no matches — callers
 *  must handle this case gracefully. */
export async function queryMemory(opts: MemoryQueryOptions): Promise<MemoryHit[]> {
  if (!opts.modelId && !opts.modelFamily) {
    throw new Error('queryMemory requires either modelId or modelFamily');
  }
  if (opts.tags.length === 0) {
    // No tags = no meaningful query. Return empty rather than fetching everything.
    return [];
  }

  const supabase = createClient();
  const limit = opts.limit ?? 5;

  let query = supabase
    .from('forum_utterances')
    .select('id, session_id, category, segment_name, turn_index, participant_seat, model_id, model_family, utterance_text, tags, spoken_at')
    .overlaps('tags', opts.tags)
    .order('spoken_at', { ascending: false })
    .limit(limit);

  // Identity filter — exact model OR family match, not both
  if (opts.modelId) {
    query = query.eq('model_id', opts.modelId);
  } else if (opts.modelFamily) {
    query = query.eq('model_family', opts.modelFamily);
  }

  if (opts.category) {
    query = query.eq('category', opts.category);
  }

  if (opts.excludeSessionIds && opts.excludeSessionIds.length > 0) {
    query = query.not('session_id', 'in', `(${opts.excludeSessionIds.join(',')})`);
  }

  const { data, error } = await query;

  if (error) {
    console.warn(`[MEMORY] Query failed: ${error.message}`);
    return [];
  }

  return (data || []).map(row => ({
    id: row.id,
    sessionId: row.session_id,
    category: row.category,
    segmentName: row.segment_name,
    turnIndex: row.turn_index,
    participantSeat: row.participant_seat,
    modelId: row.model_id,
    modelFamily: row.model_family,
    utteranceText: row.utterance_text,
    tags: row.tags || [],
    spokenAt: row.spoken_at,
  }));
}

/** Convenience: query memory for a participant on a set of agenda
 *  segment topics. Returns hits grouped per topic for easy use during
 *  agenda pre-loading. */
export async function queryMemoryForSegments(opts: {
  modelId?: string;
  modelFamily?: string;
  segmentTags: Array<{ segmentName: string; tags: string[] }>;
  category?: string;
  excludeSessionIds?: string[];
  limitPerSegment?: number;
}): Promise<Array<{ segmentName: string; hits: MemoryHit[] }>> {
  const results: Array<{ segmentName: string; hits: MemoryHit[] }> = [];

  for (const segment of opts.segmentTags) {
    const hits = await queryMemory({
      modelId: opts.modelId,
      modelFamily: opts.modelFamily,
      tags: segment.tags,
      category: opts.category,
      excludeSessionIds: opts.excludeSessionIds,
      limit: opts.limitPerSegment ?? 3,
    });
    results.push({ segmentName: segment.segmentName, hits });
  }

  return results;
}
