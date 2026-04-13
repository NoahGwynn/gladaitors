// ============================================================================
// dAIly Forum — Stage 4b: Moderator Selection
// ============================================================================
// Three functions:
//
//   1. getRotationQueue(category)
//      Queries forum_sessions for past moderator picks per category and
//      returns the active pool ordered by least-recently-moderated.
//      Models that have never moderated this category go first, in
//      pool order.
//
//   2. selectActingModerator(tiedTopicIds, broadcast, queue)
//      Fires only when a runoff produces a double-tie that the pool
//      could not break with picks + urgency. Walks graduated conflict
//      tiers (<30 → <50 → <70 → <80 → <90 → no check), picking the
//      first eligible model in rotation order at each tier.
//
//      "Conflict" here is the model's MAXIMUM declared conflict score
//      across ALL tied topics — we want a referee who can fairly choose
//      between them, not one who's compromised on any of them.
//
//      Acting moderator is NOT the actual moderator. They make a single
//      editorial call and then the actual moderator selection runs
//      separately for the chosen topic.
//
//   3. selectModerator(topicId, broadcast, queue, recentRegions)
//      The real Stage 4 moderator selection. Walks the rotation queue,
//      skipping any model with conflict ≥ 70 on the chosen topic.
//      First eligible wins. Falls back to least conflicted (with a
//      10-point tie window broken by rotation) if nobody is clean.
//      Soft cap: avoid 3rd consecutive same-region moderator unless
//      that would override the conflict rule.
//
// All decisions are deterministic and the full trace is captured for
// the session record so the published transparency layer can show
// exactly how each moderator was chosen.
// ============================================================================

import { createClient } from '@/lib/supabase';
import { getAvailablePool, type PoolModel } from './model-pool';
import type { BroadcastResult } from './broadcast';

// --- Types ---

export interface RotationEntry {
  model: PoolModel;
  /** ISO date of the most recent session this model moderated for the
   *  given category. Null if it has never moderated this category. */
  lastModeratedAt: string | null;
  /** How many times this model has moderated this category historically.
   *  Used as a secondary sort for tie-breaking inside the rotation
   *  (rare but possible). */
  totalSessions: number;
}

export interface ActingModeratorResult {
  modelId: string;
  modelName: string;
  /** Which graduated tier resolved the choice. 1 = <30 conflict (best),
   *  6 = no check at all (last resort). */
  tier: number;
  tierThreshold: number | null;
  /** This model's conflict scores on every tied topic (transparency) */
  conflicts: Record<string, number>;
  /** Maximum conflict across the tied topics (the score that placed
   *  this model in its eventual tier) */
  maxConflict: number;
}

export interface ModeratorResult {
  modelId: string;
  modelName: string;
  conflictScore: number;
  method: 'rotation_clean' | 'rotation_skipped' | 'fallback_least_conflicted';
  /** Models walked over due to conflict, in queue order. Empty if the
   *  first-in-queue model was clean. */
  skipped: Array<{
    modelId: string;
    modelName: string;
    conflictScore: number;
    reason: string;
  }>;
  regionSoftcapApplied: boolean;
}

// --- Constants ---

/** Hard threshold: any model with conflict ≥ this on the chosen topic
 *  is skipped during the actual moderator selection. */
export const MODERATOR_CONFLICT_THRESHOLD = 70;

/** When falling back to "least conflicted", any models within this
 *  number of points of the lowest score are considered tied and the
 *  rotation queue breaks the tie. */
export const FALLBACK_TIE_WINDOW = 10;

/** Soft cap on consecutive same-region moderators. The 3rd in a row
 *  triggers a swap to a different region IF an eligible alternative
 *  exists. Does not override the conflict rule. */
export const REGION_SOFTCAP_CONSECUTIVE = 2;

/** Graduated tiers for acting moderator selection. Walk in order;
 *  within each tier, walk the rotation queue. First eligible wins. */
export const ACTING_MODERATOR_TIERS: Array<{ tier: number; threshold: number | null }> = [
  { tier: 1, threshold: 30 },
  { tier: 2, threshold: 50 },
  { tier: 3, threshold: 70 },
  { tier: 4, threshold: 80 },
  { tier: 5, threshold: 90 },
  { tier: 6, threshold: null }, // no check at all — last resort
];

// --- Rotation queue ---

/** Build the rotation queue for a given category. AVAILABLE pool
 *  models (those with API keys configured) ordered by least-recently-
 *  moderated. Models without API keys are excluded — we can't pick a
 *  moderator we can't actually call. Never-moderated models go first
 *  in pool order, then oldest moderation date, then most recent. */
export async function getRotationQueue(category: string): Promise<RotationEntry[]> {
  const supabase = createClient();
  const pool = getAvailablePool();

  // For each pool model, find the most recent session in this category
  // where they moderated. If they never have, lastModeratedAt is null.
  const entries: RotationEntry[] = [];

  for (const model of pool) {
    const { data: sessions } = await supabase
      .from('forum_sessions')
      .select('session_date')
      .eq('category', category)
      .eq('moderator_model_id', model.id)
      .order('session_date', { ascending: false });

    const lastModeratedAt = sessions && sessions.length > 0 ? sessions[0].session_date : null;
    const totalSessions = sessions?.length || 0;

    entries.push({ model, lastModeratedAt, totalSessions });
  }

  // Sort: never-moderated first, then oldest moderation date first.
  // Within "never moderated", preserve pool order (the order they
  // appear in MODEL_POOL — region groups are intentional).
  entries.sort((a, b) => {
    if (a.lastModeratedAt === null && b.lastModeratedAt === null) {
      // Both never moderated — preserve pool order
      return pool.indexOf(a.model) - pool.indexOf(b.model);
    }
    if (a.lastModeratedAt === null) return -1;
    if (b.lastModeratedAt === null) return 1;
    // Both have moderated — oldest first
    if (a.lastModeratedAt !== b.lastModeratedAt) {
      return a.lastModeratedAt < b.lastModeratedAt ? -1 : 1;
    }
    // Tie on date: prefer the model with fewer total sessions
    return a.totalSessions - b.totalSessions;
  });

  return entries;
}

/** Get the regions of the most recent N moderators for this category,
 *  in chronological order (oldest first). Used for the soft region cap.
 *  Looks up regions in the full model pool (including unavailable ones)
 *  because a past moderator may have been recorded when their key was
 *  configured even if it's currently missing. */
export async function getRecentModeratorRegions(
  category: string,
  count: number = REGION_SOFTCAP_CONSECUTIVE,
): Promise<string[]> {
  const supabase = createClient();
  const pool = getAvailablePool();
  const poolById = new Map(pool.map(m => [m.id, m]));

  const { data: sessions } = await supabase
    .from('forum_sessions')
    .select('moderator_model_id, session_date')
    .eq('category', category)
    .not('moderator_model_id', 'is', null)
    .order('session_date', { ascending: false })
    .limit(count);

  if (!sessions) return [];

  // Reverse so oldest is first (chronological order)
  return sessions
    .slice()
    .reverse()
    .map(s => poolById.get(s.moderator_model_id || '')?.region || '')
    .filter(r => r !== '');
}

// --- Helper: get a model's conflict score on a specific topic ---

function getConflictScore(
  modelId: string,
  topicId: string,
  broadcast: BroadcastResult,
): number {
  const response = broadcast.responses.find(r => r.modelId === modelId);
  if (!response || response.error) return 0;
  const conflict = response.conflicts.find(c => c.threadId === topicId);
  return conflict?.conflictScore || 0;
}

/** Get the model's MAXIMUM conflict score across a set of topics.
 *  Used for acting moderator selection (referee must be clean across
 *  all tied options, not just one of them). */
function getMaxConflictAcross(
  modelId: string,
  topicIds: string[],
  broadcast: BroadcastResult,
): { max: number; perTopic: Record<string, number> } {
  const perTopic: Record<string, number> = {};
  let max = 0;
  for (const topicId of topicIds) {
    const score = getConflictScore(modelId, topicId, broadcast);
    perTopic[topicId] = score;
    if (score > max) max = score;
  }
  return { max, perTopic };
}

// --- Acting moderator selection ---

/** Select an acting moderator to break a runoff double-tie. Walks the
 *  graduated tiers; within each tier, walks the rotation queue from
 *  the front. First eligible at any tier wins. Always succeeds (the
 *  last tier has no conflict check at all).
 *
 *  Throws if the rotation queue is empty (no active pool models with
 *  broadcast responses — impossible in practice). */
export function selectActingModerator(
  tiedTopicIds: string[],
  broadcast: BroadcastResult,
  rotationQueue: RotationEntry[],
): ActingModeratorResult {
  if (rotationQueue.length === 0) {
    throw new Error('Rotation queue is empty — no eligible models for acting moderator');
  }

  // Pre-compute every queue model's conflict picture across the tied set
  const conflictPictures = new Map<
    string,
    { max: number; perTopic: Record<string, number> }
  >();
  for (const entry of rotationQueue) {
    conflictPictures.set(
      entry.model.id,
      getMaxConflictAcross(entry.model.id, tiedTopicIds, broadcast),
    );
  }

  // Walk tiers in order
  for (const { tier, threshold } of ACTING_MODERATOR_TIERS) {
    for (const entry of rotationQueue) {
      const picture = conflictPictures.get(entry.model.id)!;
      const eligible = threshold === null || picture.max < threshold;
      if (eligible) {
        return {
          modelId: entry.model.id,
          modelName: entry.model.displayName,
          tier,
          tierThreshold: threshold,
          conflicts: picture.perTopic,
          maxConflict: picture.max,
        };
      }
    }
  }

  // Tier 6 has no threshold so this is unreachable, but TypeScript
  // doesn't know that.
  throw new Error('Acting moderator tier walk exhausted with no pick — unreachable');
}

// --- Actual moderator selection ---

/** Select the actual session moderator for a chosen topic. Walks the
 *  rotation queue, skipping any model with conflict ≥ MODERATOR_CONFLICT_THRESHOLD.
 *  Applies the region soft cap (avoid 3rd consecutive same-region) only
 *  if doing so doesn't violate the conflict rule. Falls back to least
 *  conflicted with rotation tiebreaking if nobody passes.
 *
 *  recentRegions should be the regions of the last N moderators in
 *  chronological order (oldest first), as returned by getRecentModeratorRegions.
 */
export function selectModerator(
  topicId: string,
  broadcast: BroadcastResult,
  rotationQueue: RotationEntry[],
  recentRegions: string[],
): ModeratorResult {
  if (rotationQueue.length === 0) {
    throw new Error('Rotation queue is empty — no eligible models for moderator');
  }

  // Pre-compute every queue model's conflict score on the chosen topic
  const conflictScores = new Map<string, number>();
  for (const entry of rotationQueue) {
    conflictScores.set(entry.model.id, getConflictScore(entry.model.id, topicId, broadcast));
  }

  // Region softcap state — true if the last N moderators were all from
  // the same region AND we have enough history to even apply the rule.
  // If recentRegions has fewer than REGION_SOFTCAP_CONSECUTIVE entries,
  // the cap doesn't apply yet (early days, not enough history).
  const lastRegions = recentRegions.slice(-REGION_SOFTCAP_CONSECUTIVE);
  const wouldExceedRegionCap = (region: string): boolean => {
    if (lastRegions.length < REGION_SOFTCAP_CONSECUTIVE) return false;
    return lastRegions.every(r => r === region);
  };

  // Pass 1: walk queue, find first clean (and first clean from a
  // different region for the soft cap). Track ALL conflicted models
  // walked OVER to reach the chosen one — never models that come
  // after the chosen one (those weren't actually walked).
  let firstCleanIndex = -1;
  let firstCleanDifferentRegion = -1;

  for (let i = 0; i < rotationQueue.length; i++) {
    const entry = rotationQueue[i];
    const conflict = conflictScores.get(entry.model.id) || 0;

    if (conflict >= MODERATOR_CONFLICT_THRESHOLD) {
      continue; // skipped (will be recorded below if walked over)
    }

    if (firstCleanIndex === -1) firstCleanIndex = i;
    if (firstCleanDifferentRegion === -1 && !wouldExceedRegionCap(entry.model.region)) {
      firstCleanDifferentRegion = i;
    }

    // Once we have both candidates, no need to keep walking
    if (firstCleanIndex !== -1 && firstCleanDifferentRegion !== -1) break;
  }

  // Decide which clean candidate to use
  if (firstCleanIndex !== -1) {
    let chosenIdx = firstCleanIndex;
    let regionSoftcapApplied = false;
    if (firstCleanDifferentRegion !== -1 && firstCleanDifferentRegion !== firstCleanIndex) {
      // The first clean candidate would extend a same-region streak.
      // Swap to the first clean candidate from a different region.
      regionSoftcapApplied = true;
      chosenIdx = firstCleanDifferentRegion;
    }

    // Build the skipped list: only models walked OVER to reach the
    // chosen index (i.e. queue positions 0..chosenIdx-1 with conflict
    // ≥ threshold). Models past the chosen index were never walked.
    const skipped: ModeratorResult['skipped'] = [];
    for (let i = 0; i < chosenIdx; i++) {
      const entry = rotationQueue[i];
      const conflict = conflictScores.get(entry.model.id) || 0;
      if (conflict >= MODERATOR_CONFLICT_THRESHOLD) {
        skipped.push({
          modelId: entry.model.id,
          modelName: entry.model.displayName,
          conflictScore: conflict,
          reason: `Conflict ${conflict} ≥ ${MODERATOR_CONFLICT_THRESHOLD} threshold`,
        });
      }
    }

    const chosen = rotationQueue[chosenIdx];
    return {
      modelId: chosen.model.id,
      modelName: chosen.model.displayName,
      conflictScore: conflictScores.get(chosen.model.id) || 0,
      method: skipped.length > 0 ? 'rotation_skipped' : 'rotation_clean',
      skipped,
      regionSoftcapApplied,
    };
  }

  // Pass 2: nobody passed the conflict bar. Fall back to least conflicted
  // with the 10-point tie window broken by rotation order. In this branch
  // every model in the queue was over the threshold — they're all
  // recorded in `skipped` for the transparency log so readers can see
  // the full conflict picture that forced the fallback.
  const sortedByConflict = rotationQueue
    .map((entry, queueIdx) => ({
      entry,
      queueIdx,
      conflict: conflictScores.get(entry.model.id) || 0,
    }))
    .sort((a, b) => a.conflict - b.conflict);

  const minConflict = sortedByConflict[0].conflict;
  const tied = sortedByConflict.filter(x => x.conflict <= minConflict + FALLBACK_TIE_WINDOW);

  // Within the tied window, the one earliest in rotation queue wins
  tied.sort((a, b) => a.queueIdx - b.queueIdx);
  const chosen = tied[0];

  // Record the entire queue (minus the chosen one) as the conflict picture
  const fallbackSkipped: ModeratorResult['skipped'] = rotationQueue
    .filter(entry => entry.model.id !== chosen.entry.model.id)
    .map(entry => ({
      modelId: entry.model.id,
      modelName: entry.model.displayName,
      conflictScore: conflictScores.get(entry.model.id) || 0,
      reason: 'All pool models exceeded conflict threshold; fell back to least conflicted',
    }));

  return {
    modelId: chosen.entry.model.id,
    modelName: chosen.entry.model.displayName,
    conflictScore: chosen.conflict,
    method: 'fallback_least_conflicted',
    skipped: fallbackSkipped,
    regionSoftcapApplied: false,
  };
}
