// ============================================================================
// POST /api/forum/ingest — Trigger data ingestion for a category
// ============================================================================
// Manually triggers the RSS ingestion pipeline for testing. In
// production this will be replaced by a cron job.
//
// Body: { category: string }  (e.g., "ai")
// Returns: summary of what was fetched/inserted/skipped per source.
//
// No auth for now — this is an internal tool. Add auth before deploy.
// ============================================================================

import { NextRequest } from 'next/server';
import { ingestAllRss } from '@/lib/forum/ingest-rss';

export async function POST(request: NextRequest) {
  const body = await request.json() as { category?: string };
  const category = body.category || 'ai';

  console.log(`[INGEST] Starting RSS ingestion for category: ${category}`);

  const results = await ingestAllRss(category);

  const summary = {
    category,
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
