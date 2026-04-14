// ============================================================================
// POST /api/forum/cron/run-pipeline
// ============================================================================
// Kicks off the full daily pipeline for a category: organize → broadcast
// → topic select → moderator → research → cast → deep research → agenda
// → debate. This is what the morning cron calls to actually run the
// session.
//
// Runs synchronously — the full pipeline takes ~14 minutes. On Railway
// this is fine (no function timeout). On Vercel this would exceed the
// function limit — see deployment notes.
//
// The pipeline chains two internal endpoints:
//   1. /api/forum/select     (organize through agenda_built)
//   2. /api/forum/debate     (debate runtime)
//
// Security: requires Authorization header with CRON_SECRET.
// ============================================================================

import { NextRequest } from 'next/server';

const DEFAULT_CATEGORY = 'ai';

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

function getBaseUrl(request: NextRequest): string {
  // Use the request's origin so we work in dev, prod, and any tunnel
  // (ngrok, loca.lt, etc.). On Vercel/Railway prod the origin is the
  // deployed domain.
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as { category?: string };
  const category = body.category || DEFAULT_CATEGORY;
  const baseUrl = getBaseUrl(request);

  const startTime = Date.now();
  const stages: Array<{ stage: string; ok: boolean; ms: number; error?: string }> = [];

  // --- Stage 1: /api/forum/select (organize → agenda_built) ---
  console.log(`[CRON] Running /api/forum/select for ${category}`);
  const selectStart = Date.now();
  try {
    const selectRes = await fetch(`${baseUrl}/api/forum/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    const ok = selectRes.ok;
    stages.push({ stage: 'select', ok, ms: Date.now() - selectStart });
    if (!ok) {
      const text = await selectRes.text();
      stages[stages.length - 1].error = text.slice(0, 500);
      return Response.json({
        error: 'Stage /api/forum/select failed',
        stages,
        totalMs: Date.now() - startTime,
      }, { status: 500 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    stages.push({ stage: 'select', ok: false, ms: Date.now() - selectStart, error: msg });
    return Response.json({
      error: `select failed: ${msg}`,
      stages,
      totalMs: Date.now() - startTime,
    }, { status: 500 });
  }

  // --- Stage 2: /api/forum/debate ---
  console.log(`[CRON] Running /api/forum/debate for ${category}`);
  const debateStart = Date.now();
  try {
    const debateRes = await fetch(`${baseUrl}/api/forum/debate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    const ok = debateRes.ok;
    stages.push({ stage: 'debate', ok, ms: Date.now() - debateStart });
    if (!ok) {
      const text = await debateRes.text();
      stages[stages.length - 1].error = text.slice(0, 500);
      return Response.json({
        error: 'Stage /api/forum/debate failed',
        stages,
        totalMs: Date.now() - startTime,
      }, { status: 500 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    stages.push({ stage: 'debate', ok: false, ms: Date.now() - debateStart, error: msg });
    return Response.json({
      error: `debate failed: ${msg}`,
      stages,
      totalMs: Date.now() - startTime,
    }, { status: 500 });
  }

  return Response.json({
    ok: true,
    category,
    stages,
    totalMs: Date.now() - startTime,
  });
}

// Support GET for scheduled jobs that only issue GETs
export const GET = POST;
