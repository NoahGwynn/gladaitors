// ============================================================================
// POST /api/daily/ingest — Trigger full data ingestion
// ============================================================================
// Runs all ingesters (RSS, ArXiv, Hacker News, Reddit) across all
// enabled sources. Items are pre-tagged with candidate categories
// from their source config.
//
// No auth for now — this is an internal tool. Add auth before deploy.
// In production this will be triggered by a cron job.
// ============================================================================

import { ingestAllRss } from '@/lib/daily/ingest-rss';
import { ingestArxiv } from '@/lib/daily/ingest-arxiv';
import { ingestHackerNews } from '@/lib/daily/ingest-hn';
import { ingestReddit } from '@/lib/daily/ingest-reddit';
import { embedNewItems } from '@/lib/daily/embed';
import { matchItemsToThreads, markDormantThreads } from '@/lib/daily/thread-match';
import { createServerSupabase } from '@/lib/supabase-server';

interface IngestResult {
  sourceId: string;
  sourceName: string;
  fetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function POST() {
  console.log('[INGEST] Starting full ingestion (all source types)');

  const allResults: IngestResult[] = [];

  // 1. RSS feeds
  console.log('[INGEST] --- RSS feeds ---');
  const rssResults = await ingestAllRss();
  allResults.push(...rssResults);

  // 2. API sources (ArXiv, HN) + Reddit
  const supabase = await createServerSupabase();
  const { data: apiSources } = await supabase
    .from('forum_sources')
    .select('id, categories, name, url, config, source_type')
    .in('source_type', ['api', 'reddit'])
    .eq('enabled', true);

  if (apiSources) {
    for (const source of apiSources) {
      const s = source as {
        id: string;
        categories: string[];
        name: string;
        url: string;
        config: Record<string, unknown>;
        source_type: string;
      };

      console.log(`[INGEST] ${s.name} (${s.source_type})...`);

      let result: IngestResult;

      if (s.name === 'ArXiv AI' || s.source_type === 'api' && s.url?.includes('arxiv')) {
        result = await ingestArxiv(s);
      } else if (s.name === 'Hacker News' || s.source_type === 'api' && s.url?.includes('hacker-news')) {
        result = await ingestHackerNews(s);
      } else if (s.source_type === 'reddit') {
        result = await ingestReddit(s);
      } else {
        console.log(`[INGEST] Skipping unknown API source: ${s.name}`);
        continue;
      }

      console.log(
        `[INGEST] ${s.name}: ${result.fetched} fetched, ${result.inserted} inserted, ${result.skipped} skipped${result.errors.length ? `, ${result.errors.length} errors` : ''}`
      );
      allResults.push(result);
    }
  }

  const summary = {
    sources: allResults.length,
    totalFetched: allResults.reduce((s, r) => s + r.fetched, 0),
    totalInserted: allResults.reduce((s, r) => s + r.inserted, 0),
    totalSkipped: allResults.reduce((s, r) => s + r.skipped, 0),
    totalErrors: allResults.reduce((s, r) => s + r.errors.length, 0),
    details: allResults.map(r => ({
      source: r.sourceName,
      fetched: r.fetched,
      inserted: r.inserted,
      skipped: r.skipped,
      errors: r.errors,
    })),
  };

  console.log(`[INGEST] Done: ${summary.totalInserted} new items from ${summary.sources} sources`);

  // 3. Generate embeddings for new items
  console.log('[INGEST] --- Embedding generation ---');
  const embedded = await embedNewItems();
  console.log(`[INGEST] ${embedded} items embedded`);

  // 4. Match items to threads
  console.log('[INGEST] --- Thread matching ---');
  const threadResult = await matchItemsToThreads();
  console.log(`[INGEST] Threads: ${threadResult.matchedToExisting} matched, ${threadResult.newThreadsCreated} new, ${threadResult.dormantRevived} revived`);

  // 5. Mark stale threads as dormant
  const dormant = await markDormantThreads();

  return Response.json({
    ...summary,
    embedding: { embedded },
    threading: {
      processed: threadResult.itemsProcessed,
      matchedToExisting: threadResult.matchedToExisting,
      newThreadsCreated: threadResult.newThreadsCreated,
      dormantRevived: threadResult.dormantRevived,
      markedDormant: dormant,
      errors: threadResult.errors.length,
    },
  });
}
