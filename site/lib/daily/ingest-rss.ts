// ============================================================================
// the dAIly — RSS Feed Ingester
// ============================================================================
// Pulls items from RSS feeds and writes them to the forum_items table.
// One reusable function per source — configured via the forum_sources
// table, called by the ingestion cron job.
//
// Each item is deduplicated by (source_id, external_id) and by
// (category, url). If an item already exists, it's skipped.
//
// This module does NOT handle threading (matching items to threads).
// Threading is a separate step that runs after all ingesters finish.
// ============================================================================

import RssParser from 'rss-parser';
import { createClient } from '@/lib/supabase';

const parser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'gladaitor-pipeline/1.0 (https://gladaitor.ai)',
  },
});

interface IngestResult {
  sourceId: string;
  sourceName: string;
  fetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

/** Ingest all items from a single RSS source. Returns a summary. */
export async function ingestRssSource(source: {
  id: string;
  categories: string[];
  name: string;
  url: string;
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

  try {
    const feed = await parser.parseURL(source.url);
    const items = feed.items || [];
    result.fetched = items.length;

    for (const item of items) {
      const title = (item.title || '').trim();
      const link = (item.link || '').trim();

      if (!title || !link) {
        result.skipped++;
        continue;
      }

      // Apply keyword filter if configured (for broad feeds like Ars Technica)
      if (filterKeywords.length > 0) {
        const text = `${title} ${item.contentSnippet || ''} ${item.content || ''}`.toLowerCase();
        const matches = filterKeywords.some(kw => text.includes(kw.toLowerCase()));
        if (!matches) {
          result.skipped++;
          continue;
        }
      }

      // Build the external ID — prefer guid, fall back to link
      const externalId = item.guid || item.id || link;

      const summary = (item.contentSnippet || item.content || '')
        .replace(/<[^>]*>/g, '') // strip HTML tags
        .slice(0, 2000)          // cap at 2000 chars
        .trim();

      const publishedAt = item.isoDate || item.pubDate || null;

      // Upsert — skip if already exists (dedup by source_id + external_id)
      const { error: insertError } = await supabase
        .from('forum_items')
        .insert({
          source_id: source.id,
          categories: source.categories,
          external_id: externalId,
          title,
          summary: summary || null,
          url: link,
          author: item.creator || item.author || null,
          published_at: publishedAt,
          engagement: null,
          raw_payload: {
            guid: item.guid,
            rss_categories: item.categories,
            content: (item.content || '').slice(0, 5000),
          },
        })
        .select('id')
        .single();

      if (insertError) {
        // 23505 = unique constraint violation (already exists)
        if (insertError.code === '23505') {
          result.skipped++;
        } else {
          result.errors.push(`${title}: ${insertError.message}`);
        }
      } else {
        result.inserted++;
      }
    }

    // Update the source's last_fetched_at
    await supabase
      .from('forum_sources')
      .update({ last_fetched_at: new Date().toISOString(), last_error: null })
      .eq('id', source.id);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    result.errors.push(msg);

    // Record the error on the source
    await supabase
      .from('forum_sources')
      .update({ last_error: msg })
      .eq('id', source.id);
  }

  return result;
}

/** Ingest all enabled RSS sources. Shared pool — no category filter.
 *  Each item inherits its source's candidate categories. */
export async function ingestAllRss(): Promise<IngestResult[]> {
  const supabase = createClient();

  const { data: sources, error } = await supabase
    .from('forum_sources')
    .select('id, categories, name, url, config')
    .eq('source_type', 'rss')
    .eq('enabled', true);

  if (error || !sources) {
    console.error('[INGEST RSS] Failed to load sources:', error);
    return [];
  }

  const results: IngestResult[] = [];
  for (const source of sources) {
    if (!source.url) continue;
    console.log(`[INGEST RSS] ${source.name}...`);
    const result = await ingestRssSource(source as {
      id: string;
      categories: string[];
      name: string;
      url: string;
      config: Record<string, unknown>;
    });
    console.log(
      `[INGEST RSS] ${source.name}: ${result.fetched} fetched, ${result.inserted} inserted, ${result.skipped} skipped${result.errors.length ? `, ${result.errors.length} errors` : ''}`
    );
    results.push(result);
  }

  return results;
}
