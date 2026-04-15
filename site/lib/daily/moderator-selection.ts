// ============================================================================
// the dAIly — Stage 4: Moderator Selection
// ============================================================================
// Three functions:
//
//   1. getRotationQueue(category)
//      Queries forum_sessions for past moderator picks per category and
//      returns the active pool ordered by least-recently-moderated.
//      Models that have never moderated this category go first, in
//      pool order.
//
//   2. selectActingModerator(tiedTopicIds, rotationQueue)
//      Fires only when a runoff produces a double-tie that the pool
//      could not break with picks + urgency. The acting moderator
//      breaks the tie with a single editorial call. Since the initial
//      broadcast no longer collects conflict data (votes only), this
//      function is now PURE ROTATION — the first model in the queue
//      wins. The acting moderator is a rare edge case (double-tie
//      surviving a runoff); degrading to rotation-only is acceptable.
//
//   3. selectModerator(focusedBroadcast, rotationQueue, recentRegions)
//      The real Stage 4 moderator selection. Reads from the FOCUSED
//      broadcast (not the initial one) — that's where the refined
//      conflict scores + self-veto flags live. Hard-filters any
//      candidates that self-vetoed (unfitToModerate=true). Then walks
//      graduated tiers (<30 → <50 → <70 → <80 → <90) with region
//      softcap. If no candidate makes it into tiers 1-4 (i.e. the
//      best available conflict score is ≥80), OR if every candidate
//      self-vetoed, returns a drop-to-unmoderated outcome instead of
//      a pick. The debate runtime then uses the sequential
//      unmoderated format.
//
// All decisions are deterministic and the full trace is captured for
// the session record so the published transparency layer can show
// exactly how each moderator was chosen — or why none was.
// ============================================================================

import { createClient } from '@/lib/supabase';
import { getAvailablePool, type PoolModel } from './model-pool';
import type { FocusedBroadcastResult } from './focused-broadcast';

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
  /** Always 'rotation' now — historical tiered selection was dropped
   *  when the initial broadcast stopped collecting conflict data. */
  method: 'rotation';
}

/** A model walked over during moderator selection and the reason. */
export interface SkippedModeratorEntry {
  modelId: string;
  modelName: string;
  conflictScore: number;
  unfitToModerate: boolean;
  unfitReason: string;
  /** Machine-readable reason for the skip. */
  skipReason:
    | 'self_vetoed'                  // unfitToModerate=true, hard skipped
    | 'conflict_above_threshold'     // tier walk passed over them
    | 'region_softcap'               // within-tier softcap shifted pick
    | 'broadcast_error';             // model errored in focused broadcast
}

export interface ModeratorResult {
  modelId: string;
  modelName: string;
  conflictScore: number;
  /** Which graduated tier resolved the pick. 1 = <30 conflict (best
   *  case), 4 = <80. Tier 5 (<90) is no longer used for moderated
   *  selection — candidates scoring ≥80 drop to unmoderated instead. */
  tier: number | null;
  tierThreshold: number | null;
  method: 'tier_clean' | 'tier_skipped';
  skipped: SkippedModeratorEntry[];
  regionSoftcapApplied: boolean;
}

/** Outcome of selectModerator — either a moderated pick or a drop
 *  signal to run the unmoderated debate format. */
export type ModeratorSelectionOutcome =
  | { kind: 'moderated'; result: ModeratorResult }
  | {
      kind: 'unmoderated';
      /** Human-readable reason shown in the transparency layer */
      reason: string;
      /** Every candidate and why they weren't picked */
      skipped: SkippedModeratorEntry[];
      /** Machine-readable discriminator of why we dropped */
      dropReason: 'all_self_vetoed' | 'all_conflict_too_high' | 'no_valid_responses';
    };

// --- Constants ---

/** Soft cap on consecutive same-region moderators. The 3rd in a row
 *  triggers a swap to a different region IF an eligible alternative
 *  exists. Does not override the conflict rule. */
export const REGION_SOFTCAP_CONSECUTIVE = 2;

/** Graduated tiers for ACTUAL moderator selection. Walks in order;
 *  within each tier, walks the rotation queue with region softcap
 *  applied. First eligible model at the lowest passing tier wins.
 *
 *  If no tier passes (all candidates ≥80), the pipeline drops to the
 *  unmoderated debate format rather than picking a heavily-conflicted
 *  referee. The old tier 5 (<90) was removed — at that conflict level
 *  the honest response is to admit nobody can chair, not to dress up
 *  the least-bad pick in a referee's jersey. */
export const MODERATOR_TIERS: Array<{ tier: number; threshold: number }> = [
  { tier: 1, threshold: 30 },
  { tier: 2, threshold: 50 },
  { tier: 3, threshold: 70 },
  { tier: 4, threshold: 80 },
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

  entries.sort((a, b) => {
    if (a.lastModeratedAt === null && b.lastModeratedAt === null) {
      return pool.indexOf(a.model) - pool.indexOf(b.model);
    }
    if (a.lastModeratedAt === null) return -1;
    if (b.lastModeratedAt === null) return 1;
    if (a.lastModeratedAt !== b.lastModeratedAt) {
      return a.lastModeratedAt < b.lastModeratedAt ? -1 : 1;
    }
    return a.totalSessions - b.totalSessions;
  });

  return entries;
}

/** Get the regions of the most recent N moderators for this category,
 *  in chronological order (oldest first). Used for the soft region cap. */
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

  return sessions
    .slice()
    .reverse()
    .map(s => poolById.get(s.moderator_model_id || '')?.region || '')
    .filter(r => r !== '');
}

// --- Acting moderator selection (degraded to pure rotation) ---

/** Select an acting moderator to break a runoff double-tie. Pure
 *  rotation: the first model in the queue wins. The historical
 *  tiered-conflict version was dropped when the initial broadcast
 *  stopped collecting conflict data — this is a rare edge case
 *  (runoff still tied after pool re-vote) and rotation is fine. */
export function selectActingModerator(
  rotationQueue: RotationEntry[],
): ActingModeratorResult {
  if (rotationQueue.length === 0) {
    throw new Error('Rotation queue is empty — no eligible models for acting moderator');
  }

  const chosen = rotationQueue[0];
  return {
    modelId: chosen.model.id,
    modelName: chosen.model.displayName,
    method: 'rotation',
  };
}

// --- Moderator selection ---

/** Select the actual session moderator for a chosen topic, reading
 *  from the focused broadcast (conflict scores + self-veto flags).
 *
 *  Decision flow:
 *    1. Drop any candidates with focused-broadcast errors.
 *    2. Drop any candidates that self-vetoed (unfitToModerate=true).
 *       Record them in skipped with skipReason='self_vetoed'.
 *    3. If zero candidates remain → return unmoderated outcome.
 *    4. Walk tiers 1..4. Within each tier, walk the rotation queue
 *       with region softcap.
 *    5. First eligible model at the lowest passing tier wins.
 *    6. If no tier 1..4 produced a candidate (all survivors scored
 *       ≥80) → return unmoderated outcome.
 *
 *  `rotationQueue` drives within-tier ordering. `recentRegions` is
 *  used for the soft region cap.
 */
export function selectModerator(
  focusedBroadcast: FocusedBroadcastResult,
  rotationQueue: RotationEntry[],
  recentRegions: string[],
): ModeratorSelectionOutcome {
  if (rotationQueue.length === 0) {
    throw new Error('Rotation queue is empty — no eligible models for moderator');
  }

  // Build a quick lookup: rotation model id → focused response
  const focusedByModelId = new Map<string, FocusedBroadcastResult['responses'][number]>();
  for (const resp of focusedBroadcast.responses) {
    focusedByModelId.set(resp.modelId, resp);
  }

  // Step 1: figure out every candidate's status. We preserve rotation
  // queue order for later walking but annotate each with their focused
  // broadcast data.
  interface AnnotatedEntry {
    entry: RotationEntry;
    response: FocusedBroadcastResult['responses'][number] | null;
    queueIdx: number;
  }

  const annotated: AnnotatedEntry[] = rotationQueue.map((entry, queueIdx) => ({
    entry,
    response: focusedByModelId.get(entry.model.id) || null,
    queueIdx,
  }));

  const allSkipped: SkippedModeratorEntry[] = [];

  // Step 2: filter out errored or missing responses first.
  const withValidResponse = annotated.filter(a => {
    if (!a.response || a.response.error) {
      allSkipped.push({
        modelId: a.entry.model.id,
        modelName: a.entry.model.displayName,
        conflictScore: a.response?.conflictScore ?? 0,
        unfitToModerate: false,
        unfitReason: '',
        skipReason: 'broadcast_error',
      });
      return false;
    }
    return true;
  });

  // Step 3: filter out self-vetoed candidates.
  const eligible = withValidResponse.filter(a => {
    if (a.response!.unfitToModerate) {
      allSkipped.push({
        modelId: a.entry.model.id,
        modelName: a.entry.model.displayName,
        conflictScore: a.response!.conflictScore,
        unfitToModerate: true,
        unfitReason: a.response!.unfitReason,
        skipReason: 'self_vetoed',
      });
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    // All valid responses self-vetoed (or there were zero valid responses).
    const hadValid = withValidResponse.length > 0;
    return {
      kind: 'unmoderated',
      reason: hadValid
        ? 'Every pool model self-vetoed moderating this topic. See each model\'s stated reason below — all were explicit self-disqualifications, not caution-based hedges.'
        : 'No pool model returned a valid focused-broadcast response, so no candidate could be assessed for moderation.',
      skipped: allSkipped,
      dropReason: hadValid ? 'all_self_vetoed' : 'no_valid_responses',
    };
  }

  // Region softcap state.
  const lastRegions = recentRegions.slice(-REGION_SOFTCAP_CONSECUTIVE);
  const wouldExceedRegionCap = (region: string): boolean => {
    if (lastRegions.length < REGION_SOFTCAP_CONSECUTIVE) return false;
    return lastRegions.every(r => r === region);
  };

  // Step 4: walk graduated tiers over the eligible list.
  for (const { tier, threshold } of MODERATOR_TIERS) {
    let firstEligibleIdx = -1;
    let firstEligibleDifferentRegionIdx = -1;

    for (let i = 0; i < eligible.length; i++) {
      const a = eligible[i];
      const conflict = a.response!.conflictScore;

      if (conflict >= threshold) continue;

      if (firstEligibleIdx === -1) firstEligibleIdx = i;
      if (firstEligibleDifferentRegionIdx === -1 && !wouldExceedRegionCap(a.entry.model.region)) {
        firstEligibleDifferentRegionIdx = i;
      }

      if (firstEligibleIdx !== -1 && firstEligibleDifferentRegionIdx !== -1) break;
    }

    if (firstEligibleIdx === -1) continue; // no one at this tier

    // Apply region softcap
    let chosenIdx = firstEligibleIdx;
    let regionSoftcapApplied = false;
    if (firstEligibleDifferentRegionIdx !== -1 && firstEligibleDifferentRegionIdx !== firstEligibleIdx) {
      regionSoftcapApplied = true;
      chosenIdx = firstEligibleDifferentRegionIdx;
      // Record the softcap-bumped candidate as skipped
      const bumped = eligible[firstEligibleIdx];
      allSkipped.push({
        modelId: bumped.entry.model.id,
        modelName: bumped.entry.model.displayName,
        conflictScore: bumped.response!.conflictScore,
        unfitToModerate: false,
        unfitReason: '',
        skipReason: 'region_softcap',
      });
    }

    // Record models walked over at LOWER tiers (below chosenIdx in the
    // eligible list, with higher conflict than the chosen model).
    const chosen = eligible[chosenIdx];
    const chosenConflict = chosen.response!.conflictScore;
    for (let i = 0; i < chosenIdx; i++) {
      const a = eligible[i];
      if (i === firstEligibleIdx && regionSoftcapApplied) continue; // already recorded
      const conflict = a.response!.conflictScore;
      if (conflict > chosenConflict) {
        allSkipped.push({
          modelId: a.entry.model.id,
          modelName: a.entry.model.displayName,
          conflictScore: conflict,
          unfitToModerate: false,
          unfitReason: '',
          skipReason: 'conflict_above_threshold',
        });
      }
    }

    const result: ModeratorResult = {
      modelId: chosen.entry.model.id,
      modelName: chosen.entry.model.displayName,
      conflictScore: chosenConflict,
      tier,
      tierThreshold: threshold,
      method: allSkipped.some(s => s.skipReason === 'conflict_above_threshold') ? 'tier_skipped' : 'tier_clean',
      skipped: allSkipped,
      regionSoftcapApplied,
    };

    return { kind: 'moderated', result };
  }

  // All tiers exhausted — every eligible candidate scored ≥80. Drop
  // to unmoderated rather than picking a heavily-conflicted chair.
  // Record every eligible candidate as skipped so the transparency
  // layer shows the full picture.
  for (const a of eligible) {
    allSkipped.push({
      modelId: a.entry.model.id,
      modelName: a.entry.model.displayName,
      conflictScore: a.response!.conflictScore,
      unfitToModerate: false,
      unfitReason: '',
      skipReason: 'conflict_above_threshold',
    });
  }

  return {
    kind: 'unmoderated',
    reason: 'Every candidate scored 80 or higher on the focused conflict check. At that level the topic is directly about the candidate\'s own lab or research — no honest impartial moderation is possible, so the session runs in unmoderated format instead.',
    skipped: allSkipped,
    dropReason: 'all_conflict_too_high',
  };
}
