// ============================================================================
// dAIly Forum — Hacker News API Ingester
// ============================================================================
// Pulls top stories from the HN Firebase API and filters for AI-relevant
// items using keyword matching on the title. Each story becomes one
// forum_item with the HN item ID as external_id and engagement signals
// (score, comment count).
//
// HN API docs: https://github.com/HackerNews/API
// No auth required, no rate limit documented.
// ============================================================================

import { createClient } from '@/lib/supabase';

interface HNItem {
  id: number;
  title: string;
  url?: string;
  by?: string;
  score?: number;
  descendants?: number; // comment count
  time?: number;        // unix timestamp
  type?: string;
}

interface IngestResult {
  sourceId: string;
  sourceName: string;
  fetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

/** Fetch a single HN item by ID. */
async function fetchHNItem(id: number): Promise<HNItem | null> {
  try {
    const res = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Ingest AI-relevant stories from Hacker News. */
export async function ingestHackerNews(source: {
  id: string;
  categories: string[];
  name: string;
  config: Record<string, unknown>;
}): Promise<IngestResult> {
  const result: IngestResult = {
    sourceId: source.id,
    sourceName: source.name,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
  };

  const supabase = createClient();
  const filterKeywords = (source.config.filterKeywords as string[]) || [];
  const maxItems = (source.config.maxItems as number) || 30;

  try {
    // Get top story IDs
    const topRes = await fetch(
      'https://hacker-news.firebaseio.com/v0/topstories.json',
      { signal: AbortSignal.timeout(15000) }
    );
    if (!topRes.ok) {
      result.errors.push(`Top stories: HTTP ${topRes.status}`);
      return result;
    }

    const topIds: number[] = await topRes.json();
    // Take more than maxItems because many won't match the keyword filter
    const candidates = topIds.slice(0, maxItems * 3);

    // Fetch items in parallel (batches of 10 to be polite)
    const items: HNItem[] = [];
    for (let i = 0; i < candidates.length; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const fetched = await Promise.all(batch.map(fetchHNItem));
      items.push(...fetched.filter((it): it is HNItem => it !== null && it.type === 'story'));
    }

    // Filter by keywords if configured
    const filtered = filterKeywords.length > 0
      ? items.filter(it => {
          const text = (it.title || '').toLowerCase();
          return filterKeywords.some(kw => text.includes(kw.toLowerCase()));
        })
      : items;

    // Cap at maxItems
    const toIngest = filtered.slice(0, maxItems);
    result.fetched = toIngest.length;

    for (const item of toIngest) {
      // HN self-posts don't have a URL — link to the HN discussion
      const url = item.url || `https://news.ycombinator.com/item?id=${item.id}`;
      const hnUrl = `https://news.ycombinator.com/item?id=${item.id}`;

      const { error: insertError } = await supabase
        .from('forum_items')
        .insert({
          source_id: source.id,
          categories: source.categories,
          external_id: String(item.id),
          title: item.title || '',
          summary: null, // HN API doesn't provide summaries
          url,
          author: item.by || null,
          published_at: item.time ? new Date(item.time * 1000).toISOString() : null,
          engagement: {
            score: item.score || 0,
            comments: item.descendants || 0,
            hn_url: hnUrl,
          },
          raw_payload: {
            hn_id: item.id,
            score: item.score,
            descendants: item.descendants,
            type: item.type,
          },
        })
        .select('id')
        .single();

      if (insertError) {
        if (insertError.code === '23505') result.skipped++;
        else result.errors.push(`${(item.title || '').slice(0, 60)}: ${insertError.message}`);
      } else {
        result.inserted++;
      }
    }

    await supabase
      .from('forum_sources')
      .update({ last_fetched_at: new Date().toISOString(), last_error: null })
      .eq('id', source.id);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    result.errors.push(msg);
    await supabase
      .from('forum_sources')
      .update({ last_error: msg })
      .eq('id', source.id);
  }

  return result;
}
