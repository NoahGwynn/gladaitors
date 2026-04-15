// ============================================================================
// dAIly Forum — Schedule Configuration
// ============================================================================
// The source of truth for when the session page shows what. The times
// exposed here DO NOT drive when cron jobs actually fire — Railway's
// own scheduler owns those triggers. What the code needs these for is:
//
//   1. The ScheduledState page rendering today's schedule before the
//      pipeline runs ("Here's what happens and when")
//   2. Helpers like getTodayInForumTz() that compute "today" in the
//      forum's preferred timezone (which is what every session_date
//      should be relative to)
//
// If you change the times below, you ALSO need to update the cron
// entries in Railway's dashboard to match. Keep them in sync manually.
//
// All times are in FORUM_TIMEZONE (defaults to Europe/London). Per-
// category overrides let you stagger different categories later —
// e.g. AI debates at 16:00, Science at 17:00 — without duplicating
// logic.
// ============================================================================

/** IANA timezone name. Determines what "today" means and what hour a
 *  user at the session page is reading the schedule in. */
export const FORUM_TIMEZONE: string = process.env.FORUM_TIMEZONE || 'Europe/London';

// --- Schedule constants ---

/** A stage in the daily pipeline that has a user-visible start time. */
export type ScheduleStage = 'createSession' | 'organize' | 'prepare' | 'debate';

interface StageTime {
  hour: number;
  minute: number;
}

/** Default start times for the AI category — the pilot. Overridable
 *  globally via FORUM_{STAGE}_HOUR / FORUM_{STAGE}_MINUTE, or per-category
 *  via FORUM_{CATEGORY}_{STAGE}_HOUR / FORUM_{CATEGORY}_{STAGE}_MINUTE.
 *  Range is 0-23 for hours, 0-59 for minutes. */
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

/** Get the schedule time for a given stage and category. Checks
 *  per-category env overrides first, then global env overrides, then
 *  the compiled defaults. Returns { hour, minute } in FORUM_TIMEZONE. */
export function getStageTime(stage: ScheduleStage, category: string = 'ai'): StageTime {
  const stageUpper = stage.toUpperCase(); // 'ORGANIZE', 'PREPARE', etc.
  const catUpper = category.toUpperCase();
  const fallback = DEFAULTS[stage];

  const hour = intEnv(
    `FORUM_${catUpper}_${stageUpper}_HOUR`,
    intEnv(`FORUM_${stageUpper}_HOUR`, fallback.hour),
  );
  const minute = intEnv(
    `FORUM_${catUpper}_${stageUpper}_MINUTE`,
    intEnv(`FORUM_${stageUpper}_MINUTE`, fallback.minute),
  );

  return { hour, minute };
}

/** Format a StageTime as a display string (HH:MM, zero-padded). */
export function formatStageTime(t: StageTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// --- Date / timezone helpers ---

/** Get the current date string (YYYY-MM-DD) in the forum timezone. */
export function getTodayInForumTz(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: FORUM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

/** Construct a Date representing a specific hour/minute on a specific
 *  calendar day in the configured forum timezone. Handles DST
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
    timeZone: FORUM_TIMEZONE,
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
 *  already passed in the forum tz, rolls forward to tomorrow. */
export function nextStageStart(
  stage: ScheduleStage,
  category: string = 'ai',
  now: Date = new Date(),
): Date {
  const { hour, minute } = getStageTime(stage, category);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FORUM_TIMEZONE,
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
 *  forum tz. Used by the session page to decide whether to render the
 *  pre-pipeline ScheduledState or the active pipeline view. */
export function isBeforeDebateStart(category: string = 'ai', now: Date = new Date()): boolean {
  const next = nextStageStart('debate', category, now);
  const today = getTodayInForumTz(now);
  const nextDay = getTodayInForumTz(next);
  return today === nextDay;
}
