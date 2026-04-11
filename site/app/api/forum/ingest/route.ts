// ============================================================================
// POST /api/forum/ingest — Trigger data ingestion (all sources)
// ============================================================================
// Manually triggers the RSS ingestion pipeline for testing. In
// production this will be replaced by a cron job.
//
// No body required — ingests from ALL enabled RSS sources. Items are
// pre-tagged with candidate categories from their source config.
//
// No auth for now — this is an internal tool. Add auth before deploy.
// ============================================================================

import { ingestAllRss } from '@/lib/forum/ingest-rss';

export async function POST() {
  console.log('[INGEST] Starting RSS ingestion (all sources)');

  const results = await ingestAllRss();

  const summary = {
    sources: results.length,
    totalFetched: results.reduce((s, r) => s + r.fetched, 0),
    totalInserted: results.reduce((s, r) => s + r.inserted, 0),
    totalSkipped: results.reduce((s, r) => s + r.skipped, 0),
    totalErrors: results.reduce((s, r) => s + r.errors.length, 0),
    details: results.map(r => ({
      source: r.sourceName,
      fetched: r.fetched,
      inserted: r.inserted,
      skipped: r.skipped,
      errors: r.errors,
    })),
  };

  console.log(`[INGEST] Done: ${summary.totalInserted} new items from ${summary.sources} sources`);

  return Response.json(summary);
}
