// ============================================================================
// dAIly Forum — Session Journey Derivation
// ============================================================================
// Pure function that walks a forum_sessions row and emits an ordered
// timeline of journey events. The derivation function is the single
// source of the published session journey UI: the snapshots in the
// row are the data, this function shapes them for display.
//
// Design principles:
// - Stateless: same input always produces the same output
// - Tolerant: handles in-progress sessions (some snapshots may be null)
// - Forward-compatible with streaming: each snapshot can carry
//   _startedAt/_completedAt timestamps which the events expose
// - Single source of truth: no parallel events table, the session
//   row IS the journey
//
// Stages 5 (cast selection) and 6 (debate) will add their own event
// types here as they're built. The shape stays the same.
// ============================================================================

import type { OrganizeResult } from './organize';
import type { BroadcastResult, ModelBroadcastResponse } from './broadcast';
import type { RunoffResult } from './topic-selection';

// --- Types ---

export interface JourneyEvent {
  /** Pipeline stage number (2-6) */
  stage: number;
  /** Human-readable stage label */
  stageName: string;
  /** Machine-readable step identifier (e.g. 'organizers_complete') */
  step: string;
  /** Short headline for the UI timeline */
  title: string;
  /** One-paragraph plain explanation for users */
  description: string;
  /** ISO timestamp of when this step happened, if known */
  timestamp?: string;
  /** Step-specific structured payload for the UI to render details */
  data: unknown;
}

/** Snapshot envelope — the shape we wrap each Stage's result in when
 *  persisting it. _startedAt and _completedAt are added by the endpoint
 *  before the spread. The journey function reads them via these names
 *  but tolerates their absence (older sessions may not have them). */
interface SnapshotMeta {
  _startedAt?: string;
  _completedAt?: string;
}

/** What the derivation function expects to read from a forum_sessions row.
 *  Defined here independently of the supabase row type so this module
 *  has no DB dependency and can be unit-tested with synthetic data. */
export interface SessionRowForJourney {
  id: string;
  category: string;
  session_date: string;
  status: string;
  created_at: string;
  completed_at?: string | null;

  organize_snapshot?: (OrganizeResult & SnapshotMeta) | null;
  broadcast_snapshot?: (BroadcastResult & SnapshotMeta) | null;

  vote_scores?: Array<{ threadId: string; score: number; voterCount: number }> | null;
  was_runoff?: boolean | null;
  runoff_snapshot?: (RunoffResult & SnapshotMeta) | null;

  was_acting_moderator?: boolean | null;
  acting_moderator_model_id?: string | null;
  acting_moderator_tier?: number | null;
  acting_moderator_reasoning?: string | null;
  acting_moderator_conflicts?: Record<string, number> | null;

  selected_thread_id?: string | null;

  moderator_model_id?: string | null;
  moderator_conflict_score?: number | null;
  moderator_tier?: number | null;
  moderator_selection_method?: string | null;
  moderator_skipped?: Array<{
    modelId: string;
    modelName: string;
    conflictScore: number;
    reason: string;
  }> | null;
  moderator_region_softcap_applied?: boolean | null;

  error?: string | null;
}

// --- Stage labels (single source of truth) ---

const STAGE_NAMES: Record<number, string> = {
  2: 'Editorial Organizers',
  3: 'Pool Broadcast',
  4: 'Topic & Moderator Selection',
  5: 'Cast Selection',
  6: 'Debate Session',
};

// --- Derivation ---

/** Walk a forum_sessions row and produce an ordered list of journey
 *  events. Each event represents a logical step the pipeline took.
 *  The function tolerates partial data — only emits events for stages
 *  that have completed (or partial) snapshots. */
export function deriveSessionJourney(session: SessionRowForJourney): JourneyEvent[] {
  const events: JourneyEvent[] = [];

  // === Session created ===
  events.push({
    stage: 2,
    stageName: STAGE_NAMES[2],
    step: 'session_created',
    title: `${session.category.toUpperCase()} forum session opened`,
    description: `A new ${session.category} forum session was created for ${session.session_date}. The pipeline will now run through organize, broadcast, topic selection, and moderator assignment.`,
    timestamp: session.created_at,
    data: { sessionId: session.id, category: session.category, sessionDate: session.session_date },
  });

  // === Stage 2: Organize ===
  if (session.organize_snapshot) {
    events.push(...buildOrganizeEvents(session.organize_snapshot));
  }

  // === Stage 3: Broadcast ===
  if (session.broadcast_snapshot) {
    events.push(...buildBroadcastEvents(session.broadcast_snapshot));
  }

  // === Stage 4: Topic selection ===
  if (session.vote_scores && session.vote_scores.length > 0) {
    events.push(...buildVoteScoringEvents(session));
  }

  if (session.was_runoff && session.runoff_snapshot) {
    events.push(...buildRunoffEvents(session));
  }

  if (session.was_acting_moderator && session.acting_moderator_model_id) {
    events.push(buildActingModeratorEvent(session));
  }

  if (session.selected_thread_id && (session.status === 'topic_selected' || session.status === 'moderator_selected' || session.status === 'completed')) {
    events.push(buildTopicSelectedEvent(session));
  }

  // === Stage 4: Moderator selection ===
  if (session.moderator_model_id) {
    events.push(buildModeratorSelectedEvent(session));
  }

  // === Failure ===
  if (session.status === 'failed' && session.error) {
    events.push({
      stage: 4,
      stageName: STAGE_NAMES[4],
      step: 'session_failed',
      title: 'Session failed',
      description: `The pipeline stopped: ${session.error}`,
      timestamp: session.completed_at || undefined,
      data: { error: session.error },
    });
  }

  return events;
}

// --- Stage 2 events ---

function buildOrganizeEvents(snapshot: OrganizeResult & SnapshotMeta): JourneyEvent[] {
  const events: JourneyEvent[] = [];

  const agreedCount = snapshot.mergedShortlist.filter(t => t.organizerAgreement === 2).length;
  const divergedCount = snapshot.mergedShortlist.length - agreedCount;
  const revisitInShortlist = snapshot.mergedShortlist.filter(t => t.isRevisit).length;

  const partsForDescription: string[] = [
    `Two parallel editorial organizers (Sonnet + Gemini Flash) reviewed ${snapshot.threadsEvaluated} active thread${snapshot.threadsEvaluated === 1 ? '' : 's'}`,
  ];
  if (snapshot.revisitThreadCount > 0) {
    partsForDescription[0] += ` (${snapshot.activeThreadCount} active, ${snapshot.revisitThreadCount} revisit candidate${snapshot.revisitThreadCount === 1 ? '' : 's'})`;
  }
  partsForDescription.push(`Sonnet shortlisted ${snapshot.organizerAShortlist}, Gemini Flash shortlisted ${snapshot.organizerBShortlist}.`);
  partsForDescription.push(`Both organizers agreed on ${agreedCount} thread${agreedCount === 1 ? '' : 's'}; the other ${divergedCount} represent editorial divergence.`);
  if (revisitInShortlist > 0) {
    partsForDescription.push(`${revisitInShortlist} previously-discussed thread${revisitInShortlist === 1 ? '' : 's'} ${revisitInShortlist === 1 ? 'was' : 'were'} re-shortlisted because new material had accumulated.`);
  }

  events.push({
    stage: 2,
    stageName: STAGE_NAMES[2],
    step: 'organizers_complete',
    title: `Editorial organizers shortlisted ${snapshot.mergedShortlist.length} thread${snapshot.mergedShortlist.length === 1 ? '' : 's'}`,
    description: partsForDescription.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      threadsEvaluated: snapshot.threadsEvaluated,
      activeThreadCount: snapshot.activeThreadCount,
      revisitThreadCount: snapshot.revisitThreadCount,
      organizerAShortlist: snapshot.organizerAShortlist,
      organizerBShortlist: snapshot.organizerBShortlist,
      agreedCount,
      divergedCount,
      mergedShortlist: snapshot.mergedShortlist.map(t => ({
        threadId: t.threadId,
        title: t.threadTitle,
        averageRank: t.averageRank,
        organizerAgreement: t.organizerAgreement,
        includedBy: t.includedBy,
        isRevisit: t.isRevisit,
        readyReasons: t.readyReasons,
        significance: t.significance,
      })),
    },
  });

  if (snapshot.appliedMerges && snapshot.appliedMerges.applied > 0) {
    events.push({
      stage: 2,
      stageName: STAGE_NAMES[2],
      step: 'merges_applied',
      title: `${snapshot.appliedMerges.applied} thread merge${snapshot.appliedMerges.applied === 1 ? '' : 's'} applied automatically`,
      description: 'Both organizers independently flagged these threads as the same story from different angles. The pipeline merged them so the pool sees a unified narrative instead of fragments.',
      timestamp: snapshot._completedAt,
      data: snapshot.appliedMerges,
    });
  }

  return events;
}

// --- Stage 3 events ---

function buildBroadcastEvents(snapshot: BroadcastResult & SnapshotMeta): JourneyEvent[] {
  const events: JourneyEvent[] = [];

  const succeeded = snapshot.responses.filter(r => !r.error).length;
  const failed = snapshot.responses.filter(r => r.error).length;
  const skipped = snapshot.skippedModels.length;

  // Per-model summary for the UI
  const perModel = snapshot.responses.map((r: ModelBroadcastResponse) => ({
    modelId: r.modelId,
    modelName: r.modelName,
    provider: r.provider,
    region: r.region,
    voteCount: r.votes.length,
    conflictCount: r.conflicts.length,
    stanceCount: r.stances.length,
    error: r.error,
    topVoteThreadId: r.votes.find(v => v.rank === 1)?.threadId || null,
    topConflictScore: r.conflicts.length > 0 ? Math.max(...r.conflicts.map(c => c.conflictScore)) : null,
  }));

  const descParts: string[] = [];
  descParts.push(`The merged shortlist was sent to ${snapshot.responses.length + skipped} frontier pool model${snapshot.responses.length + skipped === 1 ? '' : 's'}.`);
  descParts.push(`${succeeded} responded with votes, conflict declarations, and provisional stances.`);
  if (failed > 0) descParts.push(`${failed} failed during the call.`);
  if (skipped > 0) descParts.push(`${skipped} were skipped (no API key configured).`);
  descParts.push('Each model was anchored in its own provider identity to ground conflict declarations correctly.');

  events.push({
    stage: 3,
    stageName: STAGE_NAMES[3],
    step: 'pool_responded',
    title: `${succeeded} of ${snapshot.responses.length + skipped} frontier models returned votes, conflicts, and stances`,
    description: descParts.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      respondedCount: succeeded,
      failedCount: failed,
      skippedCount: skipped,
      perModel,
      skippedModels: snapshot.skippedModels,
      responses: snapshot.responses, // Full payload for the detail drawer
    },
  });

  return events;
}

// --- Stage 4 events ---

function buildVoteScoringEvents(session: SessionRowForJourney): JourneyEvent[] {
  const events: JourneyEvent[] = [];
  const scores = session.vote_scores!;

  // Build a title→score lookup from the broadcast (if available) so
  // we can show titles instead of raw UUIDs in the description.
  const titleByThreadId = new Map<string, string>();
  if (session.organize_snapshot) {
    for (const t of session.organize_snapshot.mergedShortlist) {
      titleByThreadId.set(t.threadId, t.threadTitle);
    }
  }

  const top = scores[0];
  const second = scores[1];
  const margin = second && top.score > 0
    ? ((top.score - second.score) / top.score) * 100
    : null;

  const topTitle = titleByThreadId.get(top.threadId) || top.threadId.slice(0, 8);
  const descParts: string[] = [
    `Votes were scored using a top-3 cutoff (3 points for a model's #1 pick, 2 for #2, 1 for #3).`,
    `"${topTitle}" led with ${top.score} point${top.score === 1 ? '' : 's'} from ${top.voterCount} voter${top.voterCount === 1 ? '' : 's'}.`,
  ];
  if (margin !== null) {
    descParts.push(`Margin to second place: ${margin.toFixed(1)}%.`);
  }

  events.push({
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'votes_scored',
    title: `Votes scored — top thread: "${topTitle}" (${top.score} points)`,
    description: descParts.join(' '),
    timestamp: session.broadcast_snapshot?._completedAt, // approximate
    data: {
      scores: scores.map(s => ({
        threadId: s.threadId,
        title: titleByThreadId.get(s.threadId) || null,
        score: s.score,
        voterCount: s.voterCount,
      })),
      marginToSecondPct: margin,
    },
  });

  return events;
}

function buildRunoffEvents(session: SessionRowForJourney): JourneyEvent[] {
  const events: JourneyEvent[] = [];
  const snapshot = session.runoff_snapshot!;

  const titleByThreadId = new Map<string, string>();
  if (session.organize_snapshot) {
    for (const t of session.organize_snapshot.mergedShortlist) {
      titleByThreadId.set(t.threadId, t.threadTitle);
    }
  }

  const tiedTitles = snapshot.tiedTopicIds.map(id => titleByThreadId.get(id) || id.slice(0, 8));

  // Tie detected event
  events.push({
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'tie_detected',
    title: `${snapshot.tiedTopicIds.length} topics tied within the 10% margin`,
    description: `The first vote did not produce a clear winner. The top ${snapshot.tiedTopicIds.length} threads (${tiedTitles.map(t => `"${t}"`).join(', ')}) are within 10% of each other in score, so the pool is being re-broadcast with just these topics for a runoff.`,
    timestamp: snapshot._startedAt,
    data: {
      tiedTopicIds: snapshot.tiedTopicIds,
      tiedTitles,
    },
  });

  // Compute urgency totals + pick counts for the runoff complete event
  const urgencyTotals: Record<string, number> = {};
  const pickCounts: Record<string, number> = {};
  for (const id of snapshot.tiedTopicIds) {
    urgencyTotals[id] = 0;
    pickCounts[id] = 0;
  }
  for (const p of snapshot.picks) {
    if (p.error) continue;
    if (p.pick && pickCounts[p.pick] !== undefined) pickCounts[p.pick]++;
    for (const [id, score] of Object.entries(p.urgency || {})) {
      if (urgencyTotals[id] !== undefined) urgencyTotals[id] += score;
    }
  }

  // Determine resolution: urgency-first
  const sortedUrgency = Object.entries(urgencyTotals).sort((a, b) => b[1] - a[1]);
  const topUrgency = sortedUrgency[0]?.[1] ?? 0;
  const secondUrgency = sortedUrgency[1]?.[1] ?? 0;
  const urgencyMargin = topUrgency > 0 ? ((topUrgency - secondUrgency) / topUrgency) * 100 : 0;
  const urgencyResolved = urgencyMargin > 5 && sortedUrgency.length > 1;
  const resolvedBy = urgencyResolved ? 'urgency' : 'picks';

  const winnerTitle = titleByThreadId.get(session.selected_thread_id || '') || 'unknown';

  const descParts: string[] = [];
  descParts.push(`The pool re-voted, this time picking exactly one topic and rating each on urgency (1-10).`);
  if (resolvedBy === 'urgency') {
    descParts.push(`Urgency totals: ${sortedUrgency.map(([id, t]) => `"${titleByThreadId.get(id) || id.slice(0,8)}" ${t}`).join(', ')}.`);
    descParts.push(`The top urgency was ${urgencyMargin.toFixed(1)}% above second place — clearly informative — so urgency resolved the runoff.`);
  } else {
    descParts.push(`Urgency totals were within the 5% noise margin (${urgencyMargin.toFixed(1)}% gap), so picks decided the tiebreak.`);
    const pickList = Object.entries(pickCounts)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `"${titleByThreadId.get(id) || id.slice(0,8)}": ${n}`)
      .join(', ');
    descParts.push(`Pick counts: ${pickList}.`);
  }

  events.push({
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'runoff_complete',
    title: `Runoff resolved by ${resolvedBy} — winner: "${winnerTitle}"`,
    description: descParts.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      urgencyTotals,
      pickCounts,
      resolvedBy,
      urgencyMarginPct: urgencyMargin,
      picks: snapshot.picks,
    },
  });

  return events;
}

function buildActingModeratorEvent(session: SessionRowForJourney): JourneyEvent {
  const tier = session.acting_moderator_tier;
  const tierLabels: Record<number, string> = {
    1: 'tier 1 (clean — max conflict <30)',
    2: 'tier 2 (max conflict <50)',
    3: 'tier 3 (max conflict <70)',
    4: 'tier 4 (max conflict <80)',
    5: 'tier 5 (max conflict <90)',
    6: 'tier 6 (no conflict check — last resort)',
  };
  const tierLabel = tier && tierLabels[tier] ? tierLabels[tier] : `tier ${tier}`;

  return {
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'acting_moderator_chosen',
    title: `Acting moderator: ${session.acting_moderator_model_id} — picked at ${tierLabel}`,
    description: `The runoff did not produce a clear winner on either picks or urgency. An acting moderator was selected from the rotation queue at ${tierLabel} to break the tie. ${session.acting_moderator_reasoning || ''} Their conflict scores on the tied topics are published for transparency.`,
    timestamp: undefined,
    data: {
      modelId: session.acting_moderator_model_id,
      tier: session.acting_moderator_tier,
      reasoning: session.acting_moderator_reasoning,
      conflicts: session.acting_moderator_conflicts,
    },
  };
}

function buildTopicSelectedEvent(session: SessionRowForJourney): JourneyEvent {
  const titleByThreadId = new Map<string, string>();
  if (session.organize_snapshot) {
    for (const t of session.organize_snapshot.mergedShortlist) {
      titleByThreadId.set(t.threadId, t.threadTitle);
    }
  }
  const title = titleByThreadId.get(session.selected_thread_id!) || 'unknown';

  return {
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'topic_selected',
    title: `Topic of the day: "${title}"`,
    description: `After ${session.was_runoff ? 'a runoff round' : 'the pool vote'}${session.was_acting_moderator ? ' and an acting moderator decision' : ''}, the forum settled on this topic for today's session.`,
    timestamp: undefined,
    data: {
      threadId: session.selected_thread_id,
      title,
      wasRunoff: session.was_runoff,
      wasActingModerator: session.was_acting_moderator,
    },
  };
}

function buildModeratorSelectedEvent(session: SessionRowForJourney): JourneyEvent {
  const tier = session.moderator_tier;
  const conflict = session.moderator_conflict_score ?? 0;
  const method = session.moderator_selection_method || 'unknown';
  const skipped = session.moderator_skipped || [];
  const softcap = session.moderator_region_softcap_applied || false;

  const tierLabels: Record<number, string> = {
    1: 'tier 1 (clean — conflict <30)',
    2: 'tier 2 (conflict <50)',
    3: 'tier 3 (conflict <70)',
    4: 'tier 4 (conflict <80)',
    5: 'tier 5 (conflict <90)',
  };
  const tierLabel = tier && tierLabels[tier]
    ? tierLabels[tier]
    : tier === null
      ? 'fallback (all five tiers exhausted; least conflicted with rotation tiebreak)'
      : `tier ${tier}`;

  const descParts: string[] = [];
  descParts.push(`The pipeline walks graduated conflict tiers (<30, <50, <70, <80, <90), with rotation order applied within each tier.`);
  descParts.push(`${session.moderator_model_id} was selected at ${tierLabel} with conflict score ${conflict} on the chosen topic.`);
  if (skipped.length > 0) {
    descParts.push(`${skipped.length} model${skipped.length === 1 ? '' : 's'} earlier in the rotation queue ${skipped.length === 1 ? 'was' : 'were'} walked past because of higher conflict on this topic: ${skipped.map(s => `${s.modelName} (${s.conflictScore})`).join(', ')}.`);
  }
  if (softcap) {
    descParts.push(`The region soft cap was applied — the first eligible model would have extended a same-region streak, so the pipeline swapped to the first eligible model from a different region.`);
  }
  descParts.push(`Selection method: ${method}.`);

  return {
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'moderator_selected',
    title: `Moderator: ${session.moderator_model_id} (${tierLabel.split(' ')[0]} ${tierLabel.split(' ')[1] || ''}, conflict ${conflict})`.trim(),
    description: descParts.join(' '),
    timestamp: session.completed_at || undefined,
    data: {
      modelId: session.moderator_model_id,
      tier,
      tierThreshold: tier ? [30, 50, 70, 80, 90][tier - 1] : null,
      conflictScore: conflict,
      method,
      skipped,
      regionSoftcapApplied: softcap,
    },
  };
}
