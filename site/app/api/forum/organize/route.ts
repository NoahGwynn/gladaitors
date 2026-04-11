// ============================================================================
// POST /api/forum/organize — Run Stage 2: parallel organizers
// ============================================================================
// Evaluates active threads for a category and produces a merged
// shortlist of candidates ready for discussion today.
//
// Body: { category: string }  (e.g., "ai")
// Returns: the merged shortlist with organizer agreement data.
//
// Separate from ingestion — runs once daily (e.g., at 7am) after
// the ingestion cron has populated the thread database.
//
// No auth for now — internal tool. Add auth before deploy.
// ============================================================================

import { NextRequest } from 'next/server';
import { organizeThreads } from '@/lib/forum/organize';

export async function POST(request: NextRequest) {
  const body = await request.json() as { category?: string };
  const category = body.category || 'ai';

  console.log(`[ORGANIZE] Starting Stage 2 for category: ${category}`);

  const result = await organizeThreads(category);

  console.log(`[ORGANIZE] Done: ${result.mergedShortlist.length} threads in merged shortlist`);

  return Response.json(result);
}
