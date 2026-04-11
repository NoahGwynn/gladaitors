// ============================================================================
// POST /api/forum/broadcast — Run Stage 3: pool broadcast
// ============================================================================
// Sends the merged shortlist from Stage 2 to all available frontier
// models in the pool. Each model returns topic votes, conflict
// declarations, and provisional stances in a single call.
//
// Body: { category: string, shortlist: MergedShortlistEntry[] }
//
// The shortlist should come from Stage 2's output. If not provided,
// this endpoint will run Stage 2 first to produce one.
//
// Returns: BroadcastResult with all model responses, skipped models,
// and any errors.
//
// No auth for now — internal tool. Add auth before deploy.
// ============================================================================

import { NextRequest } from 'next/server';
import { broadcastToPool } from '@/lib/forum/broadcast';
import { organizeThreads } from '@/lib/forum/organize';
import type { MergedShortlistEntry } from '@/lib/forum/organize';

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    category?: string;
    shortlist?: MergedShortlistEntry[];
  };
  const category = body.category || 'ai';

  let shortlist = body.shortlist;

  // If no shortlist provided, run Stage 2 first
  if (!shortlist || shortlist.length === 0) {
    console.log(`[BROADCAST] No shortlist provided — running Stage 2 for category: ${category}`);
    const organizeResult = await organizeThreads(category);
    shortlist = organizeResult.mergedShortlist;

    if (shortlist.length === 0) {
      return Response.json({
        error: 'Stage 2 produced an empty shortlist — nothing to broadcast',
        organizeResult,
      }, { status: 400 });
    }
  }

  console.log(`[BROADCAST] Starting Stage 3 for category: ${category} (${shortlist.length} threads)`);

  const result = await broadcastToPool(shortlist, category);

  const succeeded = result.responses.filter(r => !r.error).length;
  const failed = result.responses.filter(r => r.error).length;

  console.log(`[BROADCAST] Done: ${succeeded} responded, ${failed} failed, ${result.skippedModels.length} skipped`);

  return Response.json(result);
}
