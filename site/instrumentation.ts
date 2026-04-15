// ============================================================================
// Next.js instrumentation hook — in-process cron scheduler
// ============================================================================
// Runs once per Next.js server boot. Registers four cron jobs that
// fire the forum pipeline stages on schedule by making internal HTTP
// requests back to the same server with the CRON_SECRET auth header.
//
// Why in-process instead of external scheduling:
// - Single Railway service, no extra services to manage
// - Scheduling config lives next to the endpoints it triggers (one
//   source of truth via lib/forum/schedule.ts)
// - Uses the exact same HTTP + CRON_SECRET path as any external
//   caller, so manual curl and automated cron behave identically
//
// Limitation: if Railway ever runs multiple instances of this service
// simultaneously (horizontal scaling), every instance would fire the
// cron on the same schedule — double-firing. The endpoints are
// idempotent (each stage checks its own snapshot before running) so
// this is wasted work, not corruption, but it's worth avoiding at
// scale. If you move to multi-instance, disable this file by setting
// CRON_IN_PROCESS=false and add a dedicated cron worker service.
//
// This file is picked up automatically by Next.js's instrumentation
// feature — no import or wiring needed. Next.js runs `register()`
// exactly once when the server starts.
// ============================================================================

export async function register() {
  // Only run on the Node.js runtime. Next.js also calls this on the
  // Edge runtime for Edge middleware — we don't want to register the
  // cron there.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Opt-out switch — set CRON_IN_PROCESS=false in Railway env vars
  // to disable when you migrate to a dedicated cron worker service.
  if (process.env.CRON_IN_PROCESS === 'false') {
    console.log('[CRON] CRON_IN_PROCESS=false — in-process scheduler disabled');
    return;
  }

  // Don't register the scheduler during `next build`. Next.js runs
  // this file in build-time too for some things and we don't want to
  // spin up timers in a build process.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    console.log('[CRON] Skipping in build phase');
    return;
  }

  const cron = await import('node-cron');
  const { getStageTime, FORUM_TIMEZONE } = await import('./lib/forum/schedule');

  // The pilot only runs the 'ai' category. When you add more
  // categories, extend this array — each gets its own independent
  // schedule from getStageTime (which supports per-category env
  // overrides).
  const categories = ['ai'];

  const baseUrl = process.env.CRON_INTERNAL_URL
    || process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    || `http://localhost:${process.env.PORT || 3000}`;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[CRON] CRON_SECRET is not set — in-process cron will fire against an unauthenticated endpoint. Set CRON_SECRET in production.');
  }

  console.log(`[CRON] Registering in-process scheduler. Base URL: ${baseUrl}`);
  console.log(`[CRON] Timezone: ${FORUM_TIMEZONE}`);

  type StageKey = 'createSession' | 'organize' | 'prepare' | 'debate';

  /** URL path for each cron endpoint — matches the routes in
   *  app/api/forum/cron/. */
  const PATH_BY_STAGE: Record<StageKey, string> = {
    createSession: '/api/forum/cron/create-session',
    organize: '/api/forum/cron/organize',
    prepare: '/api/forum/cron/prepare',
    debate: '/api/forum/cron/debate',
  };

  /** Fire one internal HTTP request to a cron endpoint. Logs outcome
   *  but never throws — a failed cron call must not crash the Next.js
   *  server process. */
  async function fire(stage: StageKey, category: string) {
    const path = PATH_BY_STAGE[stage];
    const url = `${baseUrl}${path}?category=${encodeURIComponent(category)}`;
    const startedAt = Date.now();
    console.log(`[CRON] Firing ${stage} (${category}) → ${url}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ category }),
      });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (res.ok) {
        console.log(`[CRON] ${stage} (${category}) OK in ${elapsed}s`);
      } else {
        const text = await res.text().catch(() => '<no body>');
        console.error(`[CRON] ${stage} (${category}) FAILED ${res.status} in ${elapsed}s: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`[CRON] ${stage} (${category}) threw after ${elapsed}s: ${msg}`);
    }
  }

  /** Build a cron string for a stage + category from getStageTime. */
  function cronStringFor(stage: StageKey, category: string): string {
    const { hour, minute } = getStageTime(stage, category);
    return `${minute} ${hour} * * *`;
  }

  const stages: StageKey[] = ['createSession', 'organize', 'prepare', 'debate'];

  for (const category of categories) {
    for (const stage of stages) {
      const cronString = cronStringFor(stage, category);
      cron.schedule(
        cronString,
        () => {
          // fire-and-forget; don't await inside the cron callback
          fire(stage, category);
        },
        { timezone: FORUM_TIMEZONE },
      );
      console.log(`[CRON] Scheduled ${stage} (${category}) at "${cronString}" ${FORUM_TIMEZONE}`);
    }
  }

  console.log(`[CRON] In-process scheduler ready — ${stages.length * categories.length} jobs registered.`);
}
