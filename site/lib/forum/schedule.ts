// ============================================================================
// dAIly Forum — Schedule Configuration
// ============================================================================
// Controls when sessions are created and when the pipeline runs each day.
// All times are in a single configurable timezone (defaults to Europe/London).
//
// Override via env vars at deploy time:
//   FORUM_TIMEZONE=Europe/London     (IANA timezone name)
//   FORUM_SESSION_CREATE_HOUR=0       (0-23, hour when the scheduled row is created)
//   FORUM_PIPELINE_START_HOUR=8       (0-23, hour when organize → debate runs)
//
// The session page uses these to render the countdown on pre-pipeline days
// and to know when to swap from ScheduledState to the live pipeline view.
//
// These values can also be used directly at runtime — the cron jobs read
// them to decide when to fire, the countdown uses them to compute "time
// until next session", and the UI uses them to decide what state to show.
// ============================================================================

/** IANA timezone name. Determines what "today" means and when the cron fires. */
export const FORUM_TIMEZONE: string = process.env.FORUM_TIMEZONE || 'Europe/London';

/** Hour of the day (0-23) when tomorrow's session row is created as 'scheduled'.
 *  Defaults to midnight in the forum timezone. */
export const FORUM_SESSION_CREATE_HOUR: number = Number.parseInt(
  process.env.FORUM_SESSION_CREATE_HOUR || '0',
  10,
);

/** Hour of the day (0-23) when the full pipeline (organize → debate) kicks off.
 *  Defaults to 8am in the forum timezone. */
export const FORUM_PIPELINE_START_HOUR: number = Number.parseInt(
  process.env.FORUM_PIPELINE_START_HOUR || '8',
  10,
);

// --- Helpers ---

/** Get the current date string (YYYY-MM-DD) in the forum timezone. */
export function getTodayInForumTz(now: Date = new Date()): string {
  // Intl.DateTimeFormat gives us a zoned format we can parse
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: FORUM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD which is what we want
  return fmt.format(now);
}

/** Get the next pipeline-start moment as a Date (in UTC/epoch terms).
 *  If the current time is before today's start hour, this returns today's
 *  pipeline start. If the current time is after today's start hour, this
 *  returns tomorrow's pipeline start. */
export function nextPipelineStart(now: Date = new Date()): Date {
  // Format "now" in the forum timezone to get today's date parts
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: FORUM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const year = Number.parseInt(parts.find(p => p.type === 'year')!.value, 10);
  const month = Number.parseInt(parts.find(p => p.type === 'month')!.value, 10);
  const day = Number.parseInt(parts.find(p => p.type === 'day')!.value, 10);
  const hour = Number.parseInt(parts.find(p => p.type === 'hour')!.value, 10);

  // Construct a target Date at the pipeline start hour in the forum tz.
  // Approach: construct a Date for "today at start hour UTC", then offset
  // by the tz difference. Simpler: iterate forward until we find a time
  // that formats to the right hour. But we can compute it directly using
  // a trick — build a plain Date in UTC and correct using the offset
  // observed in the current-hour comparison.

  // Easiest correct approach: construct candidate date strings and use
  // Date.parse with an offset inferred from a round-trip.
  const candidateHour = FORUM_PIPELINE_START_HOUR;

  // Build a Date that represents "year-month-day candidateHour:00:00"
  // interpreted in FORUM_TIMEZONE.
  const candidate = dateAtHourInTz(year, month, day, candidateHour);

  // If that's already in the past (i.e. now is past today's start), roll
  // forward one day. We compare by checking if the forum-tz hour for `now`
  // is already >= candidate hour, OR if `now` is past candidate.
  if (now.getTime() >= candidate.getTime()) {
    // Next day's pipeline start
    const tomorrow = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    return tomorrow;
  }

  return candidate;
}

/** Construct a Date representing a specific hour on a specific calendar day
 *  in the configured forum timezone. Handles DST transitions correctly by
 *  using the IANA timezone lookup. */
function dateAtHourInTz(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
): Date {
  // Start with a UTC guess and correct by the timezone offset at that moment.
  // The trick: construct as UTC, ask Intl what the local time is, compute
  // the delta, apply it.
  const utcGuess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const guessDate = new Date(utcGuess);

  // What local hour does that UTC guess fall on in the forum tz?
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

  // Diff: local hour vs the hour we wanted, same day
  let hourDiff = hour - localHour;
  if (localDay !== day || localMonth !== month) {
    // The UTC guess landed on a different calendar day in the forum tz —
    // correct by 24 hours in the right direction.
    hourDiff += localDay > day || (localMonth > month) ? 24 : -24;
  }

  return new Date(utcGuess + hourDiff * 60 * 60 * 1000);
}

/** True if the current time is before today's pipeline start in the forum tz.
 *  Used by the session page to decide whether to show the ScheduledState. */
export function isBeforePipelineStart(now: Date = new Date()): boolean {
  const next = nextPipelineStart(now);
  const todayDate = getTodayInForumTz(now);
  const nextDate = getTodayInForumTz(next);
  // If the next pipeline start is still today, we're before it.
  return todayDate === nextDate;
}

/** Milliseconds until the next pipeline start. Used for countdown rendering. */
export function msUntilNextPipelineStart(now: Date = new Date()): number {
  return Math.max(0, nextPipelineStart(now).getTime() - now.getTime());
}
