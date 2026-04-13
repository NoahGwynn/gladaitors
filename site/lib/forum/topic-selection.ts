// ============================================================================
// dAIly Forum — Stage 4a: Topic Selection
// ============================================================================
// Pure functions over the Stage 3 broadcast output. Picks the topic of
// the day from the pool's votes, with a runoff path for ties and an
// urgency-based tiebreaker for stubborn ties.
//
// Decision rules (locked with the user):
//
//   1. Vote aggregation — TOP-3 CUTOFF
//      Each model contributes 3 points to its rank-1 pick, 2 to rank-2,
//      1 to rank-3, 0 to anything below. Easy to explain, ignores the
//      long tail of "I had to rank something" picks.
//
//   2. Tie detection — within 10% of the top score
//      If 2nd place is within 10% of 1st, the topic isn't clearly the
//      winner and we trigger a runoff. With 9 models in production
//      contributing 6 points each (54 total), this gives plenty of
//      differentiation for clear winners.
//
//   3. Runoff resolution — picks first, then urgency
//      The runoff broadcast asks each model to make a single pick from
//      the tied set, AND to rate every tied topic 1-10 on "how strongly
//      do you feel today's session would be incomplete without this
//      topic being covered". Picks decide first; if picks tie, urgency
//      sums break it; if urgency also ties, the acting moderator path
//      takes over (handled by moderator-selection.ts).
//
//   4. All votes count equally regardless of conflict declaration
//      Removing conflicted votes would create a perverse incentive
//      ("declare conflict to suppress topics I don't want debated").
//      Conflict only matters for moderator/cast selection.
//
// No DB access, no LLM calls — every function here is pure and testable.
// ============================================================================

import type { ModelBroadcastResponse } from './broadcast';

// --- Types ---

export interface VoteScore {
  threadId: string;
  /** Top-3 cutoff score: sum of (3 if rank 1, 2 if rank 2, 1 if rank 3, 0 otherwise) across models */
  score: number;
  /** How many models gave this thread a top-3 rank */
  voterCount: number;
  /** Per-model breakdown for transparency */
  contributions: Array<{ modelId: string; rank: number; points: number }>;
}

export interface TieDetectionResult {
  /** The clear winner if there is one, otherwise null */
  winner: string | null;
  /** All threads within the tie window of the top score (includes the top) */
  tiedTopicIds: string[];
  /** The top score (for transparency) */
  topScore: number;
  /** Margin to 2nd place as a percentage of top score (null if only one topic) */
  marginToSecondPct: number | null;
}

export interface RunoffPick {
  modelId: string;
  modelName: string;
  /** The thread this model picked from the tied set */
  pick: string | null;
  /** 1-10 urgency rating for each tied topic */
  urgency: Record<string, number>;
  error?: string;
}

export interface RunoffResult {
  tiedTopicIds: string[];
  picks: RunoffPick[];
  errors: string[];
}

export interface RunoffResolution {
  /** The thread that won the runoff if either picks or urgency resolved it */
  winner: string | null;
  /** Picks that received the most votes (may be 1 = winner, or many = pick tie) */
  topPickIds: string[];
  /** Urgency totals across all models, per tied topic */
  urgencyTotals: Record<string, number>;
  /** Threads still tied after both picks and urgency (may be empty if winner) */
  stillTiedTopicIds: string[];
  /** Which resolution stage produced the winner */
  resolvedBy: 'picks' | 'urgency' | null;
}

// --- Constants ---

/** Default tie window: 2nd place within 10% of 1st triggers a runoff */
export const DEFAULT_TIE_MARGIN_PCT = 10;

// --- Pure functions ---

/** Score the broadcast votes using the top-3 cutoff method.
 *  Each model contributes 3pts to rank 1, 2pts to rank 2, 1pt to rank 3,
 *  0 to everything below. Returns scores sorted descending. */
export function scoreVotesTop3(responses: ModelBroadcastResponse[]): VoteScore[] {
  const scoreMap = new Map<string, VoteScore>();

  for (const response of responses) {
    if (response.error) continue;
    for (const vote of response.votes) {
      const points = vote.rank === 1 ? 3 : vote.rank === 2 ? 2 : vote.rank === 3 ? 1 : 0;
      if (points === 0) continue;

      let entry = scoreMap.get(vote.threadId);
      if (!entry) {
        entry = {
          threadId: vote.threadId,
          score: 0,
          voterCount: 0,
          contributions: [],
        };
        scoreMap.set(vote.threadId, entry);
      }
      entry.score += points;
      entry.voterCount += 1;
      entry.contributions.push({
        modelId: response.modelId,
        rank: vote.rank,
        points,
      });
    }
  }

  return Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
}

/** Detect a tie at the top of the scored votes. If the gap between
 *  1st and 2nd is less than `marginPct`, all topics within that window
 *  are returned as the tied set. */
export function detectTie(
  scores: VoteScore[],
  marginPct: number = DEFAULT_TIE_MARGIN_PCT,
): TieDetectionResult {
  if (scores.length === 0) {
    return { winner: null, tiedTopicIds: [], topScore: 0, marginToSecondPct: null };
  }

  const top = scores[0];

  if (scores.length === 1) {
    return {
      winner: top.threadId,
      tiedTopicIds: [top.threadId],
      topScore: top.score,
      marginToSecondPct: null,
    };
  }

  const second = scores[1];
  // Margin: how far ahead is 1st of 2nd, as a percentage of 1st's score.
  // (top - second) / top * 100. If top is 0 we have no real signal.
  const marginPctActual = top.score === 0 ? 0 : ((top.score - second.score) / top.score) * 100;

  if (marginPctActual >= marginPct) {
    // Clear winner.
    return {
      winner: top.threadId,
      tiedTopicIds: [top.threadId],
      topScore: top.score,
      marginToSecondPct: marginPctActual,
    };
  }

  // Tied — collect all threads within the margin of the top score.
  const cutoff = top.score * (1 - marginPct / 100);
  const tiedTopicIds = scores
    .filter(s => s.score >= cutoff)
    .map(s => s.threadId);

  return {
    winner: null,
    tiedTopicIds,
    topScore: top.score,
    marginToSecondPct: marginPctActual,
  };
}

/** Resolve a runoff: count picks first, then sum urgency if picks tie.
 *  Returns the winner if either resolution stage produces one, plus the
 *  full breakdown for transparency. If picks AND urgency both tie,
 *  stillTiedTopicIds will be non-empty and the caller must invoke the
 *  acting moderator path. */
export function resolveRunoff(runoff: RunoffResult): RunoffResolution {
  // 1. Count picks per topic
  const pickCounts = new Map<string, number>();
  for (const id of runoff.tiedTopicIds) pickCounts.set(id, 0);

  for (const p of runoff.picks) {
    if (p.error || !p.pick) continue;
    if (pickCounts.has(p.pick)) {
      pickCounts.set(p.pick, (pickCounts.get(p.pick) || 0) + 1);
    }
  }

  // Find the highest pick count
  let maxPickCount = 0;
  for (const count of pickCounts.values()) {
    if (count > maxPickCount) maxPickCount = count;
  }

  const topPickIds = Array.from(pickCounts.entries())
    .filter(([, count]) => count === maxPickCount && count > 0)
    .map(([id]) => id);

  // 2. Compute urgency totals (we always compute these for the audit
  //    record, even if picks resolved the runoff)
  const urgencyTotals: Record<string, number> = {};
  for (const id of runoff.tiedTopicIds) urgencyTotals[id] = 0;

  for (const p of runoff.picks) {
    if (p.error) continue;
    for (const [topicId, score] of Object.entries(p.urgency || {})) {
      if (topicId in urgencyTotals && typeof score === 'number') {
        urgencyTotals[topicId] += score;
      }
    }
  }

  // 3. If picks produced a single winner, return it
  if (topPickIds.length === 1) {
    return {
      winner: topPickIds[0],
      topPickIds,
      urgencyTotals,
      stillTiedTopicIds: [],
      resolvedBy: 'picks',
    };
  }

  // 4. Picks tied. Use urgency among the tied-pick topics ONLY.
  //    (We don't open it back up to the full tied set — picks already
  //    eliminated those.)
  if (topPickIds.length === 0) {
    // Edge case: nobody picked anything. Fall back to urgency across
    // the original tied set.
    const sortedByUrgency = Object.entries(urgencyTotals).sort((a, b) => b[1] - a[1]);
    if (sortedByUrgency.length === 0) {
      return {
        winner: null,
        topPickIds: [],
        urgencyTotals,
        stillTiedTopicIds: runoff.tiedTopicIds,
        resolvedBy: null,
      };
    }
    const topUrgency = sortedByUrgency[0][1];
    const urgencyWinners = sortedByUrgency.filter(([, u]) => u === topUrgency).map(([id]) => id);
    if (urgencyWinners.length === 1) {
      return {
        winner: urgencyWinners[0],
        topPickIds: [],
        urgencyTotals,
        stillTiedTopicIds: [],
        resolvedBy: 'urgency',
      };
    }
    return {
      winner: null,
      topPickIds: [],
      urgencyTotals,
      stillTiedTopicIds: urgencyWinners,
      resolvedBy: null,
    };
  }

  // Picks tied between 2+ topics. Compare urgency among those topics only.
  const tiedPickUrgency = topPickIds.map(id => ({ id, urgency: urgencyTotals[id] || 0 }));
  tiedPickUrgency.sort((a, b) => b.urgency - a.urgency);
  const topUrgencyAmongPicks = tiedPickUrgency[0].urgency;
  const urgencyWinners = tiedPickUrgency
    .filter(t => t.urgency === topUrgencyAmongPicks)
    .map(t => t.id);

  if (urgencyWinners.length === 1) {
    return {
      winner: urgencyWinners[0],
      topPickIds,
      urgencyTotals,
      stillTiedTopicIds: [],
      resolvedBy: 'urgency',
    };
  }

  // Both picks and urgency are tied. Acting moderator must decide.
  return {
    winner: null,
    topPickIds,
    urgencyTotals,
    stillTiedTopicIds: urgencyWinners,
    resolvedBy: null,
  };
}
