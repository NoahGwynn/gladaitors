// ============================================================================
// the dAIly — Schedule Configuration
// ============================================================================
// The source of truth for when the session page shows what. The times
// exposed here DO NOT drive when cron jobs actually fire — the runtime
// uses the in-process scheduler in site/instrumentation.ts to trigger
// itself on Railway. What the code needs these for is:
//
//   1. The ScheduledState page rendering today's schedule before the
//      pipeline runs ("Here's what happens and when")
//   2. Helpers like getTodayInSiteTz() that compute "today" in the
//      site's configured timezone (which is what every session_date
//      is relative to)
//
// All times are in SITE_TIMEZONE (defaults to Europe/London). Per-
// category overrides let you stagger different categories later —
// e.g. AI debates at 16:00, Science at 17:00 — without duplicating
// logic.
//
// ENV VAR MIGRATION: during the FORUM_* → DAILY_* / SITE_* rename,
// every env var check reads the new name first and falls back to the
// old name, so Railway can be updated at your convenience.
// ============================================================================

/** IANA timezone name for the whole site. Determines what "today"
 *  means and what hour a user at the session page is reading the
 *  schedule in. Reads SITE_TIMEZONE first, falls back to the older
 *  FORUM_TIMEZONE env var for transition compatibility. */
export const SITE_TIMEZONE: string =
  process.env.SITE_TIMEZONE
  || process.env.FORUM_TIMEZONE
  || 'Europe/London';

// --- Schedule constants ---

/** A stage in the daily pipeline that has a user-visible start time. */
export type ScheduleStage = 'createSession' | 'organize' | 'prepare' | 'debate';

interface StageTime {
  hour: number;
  minute: number;
}

/** Default start times for the AI category — the pilot. Overridable
 *  globally via DAILY_{STAGE}_HOUR / DAILY_{STAGE}_MINUTE, or per-
 *  category via DAILY_{CATEGORY}_{STAGE}_HOUR /
 *  DAILY_{CATEGORY}_{STAGE}_MINUTE. Older FORUM_* env var names are
 *  also honoured as a fallback so Railway config can be migrated at
 *  the operator's pace. Range is 0-23 for hours, 0-59 for minutes. */
const DEFAULTS: Record<ScheduleStage, StageTime> = {
  createSession: { hour: 0,  minute: 0 },   // Row creation — midnight
  organize:      { hour: 15, minute: 15 },  // Editorial shortlist — 15 min before prepare
  prepare:       { hour: 15, minute: 30 },  // Broadcast + topic + focused + mod + research + cast + agenda
  debate:        { hour: 16, minute: 0 },   // Live debate — 16:00 UK catches US West morning scroll
};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Read an env var by its new DAILY_* name, falling back to the old
 *  FORUM_* name for transition compatibility. Returns `fallback` if
 *  neither is set or neither parses as an integer. */
function intEnvWithLegacy(newName: string, legacyName: string, fallback: number): number {
  // Check the new name first — if set, it wins even if the legacy
  // name is also set (the operator has started migrating).
  const newRaw = process.env[newName];
  if (newRaw !== undefined && newRaw !== '') {
    const n = Number.parseInt(newRaw, 10);
    if (Number.isFinite(n)) return n;
  }
  // Fall back to the legacy name for any unmigrated vars.
  return intEnv(legacyName, fallback);
}

/** Get the schedule time for a given stage and category. Checks
 *  per-category env overrides first, then global env overrides, then
 *  the compiled defaults. Each lookup honours both the new DAILY_*
 *  name and the legacy FORUM_* fallback. Returns { hour, minute } in
 *  SITE_TIMEZONE. */
export function getStageTime(stage: ScheduleStage, category: string = 'ai'): StageTime {
  const stageUpper = stage.toUpperCase(); // 'ORGANIZE', 'PREPARE', etc.
  const catUpper = category.toUpperCase();
  const fallback = DEFAULTS[stage];

  // Per-category lookup, global lookup, then default — each level
  // checks DAILY_* first with FORUM_* as a fallback.
  const hour = intEnvWithLegacy(
    `DAILY_${catUpper}_${stageUpper}_HOUR`,
    `FORUM_${catUpper}_${stageUpper}_HOUR`,
    intEnvWithLegacy(
      `DAILY_${stageUpper}_HOUR`,
      `FORUM_${stageUpper}_HOUR`,
      fallback.hour,
    ),
  );
  const minute = intEnvWithLegacy(
    `DAILY_${catUpper}_${stageUpper}_MINUTE`,
    `FORUM_${catUpper}_${stageUpper}_MINUTE`,
    intEnvWithLegacy(
      `DAILY_${stageUpper}_MINUTE`,
      `FORUM_${stageUpper}_MINUTE`,
      fallback.minute,
    ),
  );

  return { hour, minute };
}

/** Format a StageTime as a display string (HH:MM, zero-padded). */
export function formatStageTime(t: StageTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// --- Date / timezone helpers ---

/** Get the current date string (YYYY-MM-DD) in the site timezone.
 *  Every session_date in forum_sessions is relative to this, NOT to
 *  UTC. */
export function getTodayInSiteTz(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

/** Legacy alias. Prefer `getTodayInSiteTz` in new code. */
export const getTodayInForumTz = getTodayInSiteTz;

/** Construct a Date representing a specific hour/minute on a specific
 *  calendar day in the configured site timezone. Handles DST
 *  transitions correctly by using the IANA timezone lookup. */
function dateAtTimeInTz(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guessDate = new Date(utcGuess);

  const localParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(guessDate);
  const localHour = Number.parseInt(localParts.find(p => p.type === 'hour')!.value, 10);
  const localDay = Number.parseInt(localParts.find(p => p.type === 'day')!.value, 10);
  const localMonth = Number.parseInt(localParts.find(p => p.type === 'month')!.value, 10);

  let hourDiff = hour - localHour;
  if (localDay !== day || localMonth !== month) {
    hourDiff += localDay > day || (localMonth > month) ? 24 : -24;
  }

  return new Date(utcGuess + hourDiff * 60 * 60 * 1000);
}

/** Resolve a stage's next occurrence as a Date. If today's time has
 *  already passed in the site tz, rolls forward to tomorrow. */
export function nextStageStart(
  stage: ScheduleStage,
  category: string = 'ai',
  now: Date = new Date(),
): Date {
  const { hour, minute } = getStageTime(stage, category);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const year = Number.parseInt(parts.find(p => p.type === 'year')!.value, 10);
  const monthNum = Number.parseInt(parts.find(p => p.type === 'month')!.value, 10);
  const day = Number.parseInt(parts.find(p => p.type === 'day')!.value, 10);

  const candidate = dateAtTimeInTz(year, monthNum, day, hour, minute);
  if (now.getTime() >= candidate.getTime()) {
    return new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

/** True if the current moment is before today's debate start in the
 *  site tz. Used by the session page to decide whether to render the
 *  pre-pipeline ScheduledState or the active pipeline view. */
export function isBeforeDebateStart(category: string = 'ai', now: Date = new Date()): boolean {
  const next = nextStageStart('debate', category, now);
  const today = getTodayInSiteTz(now);
  const nextDay = getTodayInSiteTz(next);
  return today === nextDay;
}
