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
import type { ResearchResult, DeepResearchResult } from './research';
import type { CastSelectionResult, CastParticipant, AlsoInvitedEntry } from './cast-selection';
import type { AgendaBuildResult, AgendaSegment } from './agenda';
import type { DebateSnapshot } from './debate-runtime';

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
  research_snapshot?: (ResearchResult & SnapshotMeta) | null;
  cast_snapshot?: (CastSelectionResult & SnapshotMeta) | null;
  session_type?: 'debate' | 'fireside_chat' | null;
  deep_research_snapshot?: (DeepResearchResult & SnapshotMeta) | null;
  agenda_snapshot?: (AgendaBuildResult & SnapshotMeta) | null;
  debate_snapshot?: (DebateSnapshot & SnapshotMeta) | null;

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
  5: 'Moderator Preparation',
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
    title: `Today's session opened`,
    description:
      `A new dAIly ${session.category === 'ai' ? 'AI' : session.category} session started. From here the forum will run through six stages in order — picking the topic, assembling the voices, doing the research, building the agenda, and running the debate. You can watch it happen live as each stage completes.`,
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

  // Once a thread is selected, surface the topic_selected event regardless
  // of how far the rest of the pipeline has progressed. The snapshot
  // (selected_thread_id) is the source of truth, not the status string.
  if (session.selected_thread_id) {
    events.push(buildTopicSelectedEvent(session));
  }

  // === Stage 4: Moderator selection ===
  if (session.moderator_model_id) {
    events.push(buildModeratorSelectedEvent(session));
  }

  // === Stage 5a: Research ===
  if (session.research_snapshot) {
    events.push(buildResearchEvent(session.research_snapshot));
  }

  // === Stage 5b: Cast selection ===
  if (session.cast_snapshot) {
    events.push(...buildCastEvents(session.cast_snapshot, session.session_type));
  }

  // === Stage 5c-i: Deep research ===
  if (session.deep_research_snapshot) {
    events.push(buildDeepResearchEvent(session.deep_research_snapshot));
  }

  // === Stage 5c-ii: Agenda ===
  if (session.agenda_snapshot) {
    events.push(buildAgendaEvent(session.agenda_snapshot, session.session_type));
  }

  // === Stage 6: Debate ===
  if (session.debate_snapshot) {
    events.push(buildDebateEvent(session.debate_snapshot, session.session_type));
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
  const shortlistCount = snapshot.mergedShortlist.length;

  const descParts: string[] = [];
  descParts.push(
    `Before the forum picks a topic, two AI editors independently read every story the pipeline gathered overnight — ${snapshot.threadsEvaluated} of them this morning. They don't compare notes. Each picks what they think is worth discussing today.`,
  );
  if (agreedCount > 0 && divergedCount > 0) {
    descParts.push(
      `${agreedCount} ${agreedCount === 1 ? 'story' : 'stories'} made both editors' shortlists — these are the strongest candidates. The other ${divergedCount} represent editorial divergence: one editor flagged something the other missed, and those are worth putting to the wider pool too.`,
    );
  } else if (agreedCount > 0) {
    descParts.push(
      `All ${agreedCount} shortlisted ${agreedCount === 1 ? 'story' : 'stories'} made both editors' lists — they agreed on every pick today.`,
    );
  } else if (divergedCount > 0) {
    descParts.push(
      `The editors disagreed on everything today — each picked different stories. Rather than discard the divergences, they're passed to the pool so a wider set of voices can weigh in.`,
    );
  }
  if (revisitInShortlist > 0) {
    descParts.push(
      `${revisitInShortlist} of the shortlisted ${revisitInShortlist === 1 ? 'story is a revisit — a topic' : 'stories are revisits — topics'} the forum has discussed before where significant new material has emerged since.`,
    );
  }

  events.push({
    stage: 2,
    stageName: STAGE_NAMES[2],
    step: 'organizers_complete',
    title: `${shortlistCount} ${shortlistCount === 1 ? 'story' : 'stories'} made today's shortlist`,
    description: descParts.join(' '),
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
    const n = snapshot.appliedMerges.applied;
    events.push({
      stage: 2,
      stageName: STAGE_NAMES[2],
      step: 'merges_applied',
      title: `${n} duplicate ${n === 1 ? 'story was' : 'stories were'} merged`,
      description:
        `Sometimes two different feeds cover the same underlying story from different angles, and both editors flag this when they see it. When both agree a pair of stories is really one, the pipeline merges them so the pool weighs them as a single topic.`,
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

  const totalPool = snapshot.responses.length + skipped;
  const descParts: string[] = [];
  descParts.push(
    `The shortlist went out to ${totalPool} frontier models from different labs. Each was asked three things: which stories they'd most want to discuss today, where they have a conflict of interest (a story about their own lab, for instance), and what position they'd take on each topic if selected.`,
  );
  descParts.push(
    `${succeeded} responded. Their votes decide the topic; their conflict declarations decide who can moderate and who gets a seat as a participant.`,
  );
  if (failed > 0) {
    descParts.push(`${failed} ${failed === 1 ? 'call' : 'calls'} failed for technical reasons — those models sit out this round.`);
  }
  if (skipped > 0) {
    descParts.push(`${skipped} ${skipped === 1 ? 'model is' : 'models are'} not yet wired into the forum.`);
  }

  events.push({
    stage: 3,
    stageName: STAGE_NAMES[3],
    step: 'pool_responded',
    title: `${succeeded} models weighed in`,
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
  const descParts: string[] = [];
  descParts.push(
    `Each model ranked their top three stories from the shortlist. A model's first pick is worth 3 points, second pick 2, third pick 1. The story with the most points wins — unless the top two finish within 10% of each other, in which case it goes to a runoff.`,
  );
  descParts.push(
    `"${topTitle}" came out on top with ${top.score} point${top.score === 1 ? '' : 's'} from ${top.voterCount} voter${top.voterCount === 1 ? '' : 's'}${margin !== null ? `, ${margin.toFixed(1)}% ahead of second place` : ''}.`,
  );
  if (margin !== null && margin < 10) {
    descParts.push(
      `That's within the 10% runoff margin, so the top stories go back to the pool for a tiebreaker vote.`,
    );
  } else if (margin !== null) {
    descParts.push(
      `That's a comfortable lead — no runoff needed.`,
    );
  }

  events.push({
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'votes_scored',
    title: `Votes tallied — "${topTitle}" leads`,
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
  const tiedCount = snapshot.tiedTopicIds.length;

  // Tie detected event
  events.push({
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'tie_detected',
    title: tiedCount === 2 ? `Two stories tied for the top spot` : `${tiedCount} stories tied for the top spot`,
    description:
      `No single story won clearly — ${tiedCount === 2 ? 'two' : tiedCount} came out within 10% of each other on the first vote. Rather than pick one arbitrarily, the forum goes back to the pool with a sharper question for the tied stories: which of these would today's session be genuinely incomplete to skip?`,
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
  if (resolvedBy === 'urgency') {
    descParts.push(
      `On the second vote the pool rated each tied story 1-10 on whether the session would be incomplete without it. "${winnerTitle}" came out clearly on top — the urgency gap to second place was large enough to call it a decisive result.`,
    );
  } else {
    descParts.push(
      `On the second vote the pool rated urgency 1-10 and also picked their single favourite among the tied stories. The urgency ratings were essentially tied (within 5% of each other), so the call fell to the single-pick tiebreaker. "${winnerTitle}" took it.`,
    );
  }

  events.push({
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'runoff_complete',
    title: `Runoff broke the tie — "${winnerTitle}" takes today`,
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
    title: `Acting referee stepped in to break the tie`,
    description:
      `The runoff couldn't separate the tied stories — both the pool's picks and their urgency ratings ended up level. In that (rare) case, the forum brings in an "acting moderator" from the rotation queue whose job is just to make the final call. Their conflict scores on the tied stories are published so their decision is transparent.`,
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

  const descParts: string[] = [];
  descParts.push(
    `"${title}" is what today's session will discuss in depth.`,
  );
  if (session.was_runoff) {
    descParts.push(`It took a runoff round to settle it.`);
  } else {
    descParts.push(`The pool picked it decisively on the first vote.`);
  }

  return {
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'topic_selected',
    title: `Today's topic: "${title}"`,
    description: descParts.join(' '),
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
  const modelName = session.moderator_model_id || 'a model';

  const descParts: string[] = [];
  descParts.push(
    `${modelName} will run today's session. The moderator is neutral — they facilitate the discussion, they don't argue a position.`,
  );

  // Explain the selection
  if (conflict < 30) {
    descParts.push(
      `They were picked because the rotation queue put them next in line and they have essentially no personal stake in the chosen topic (conflict score ${conflict}/100).`,
    );
  } else if (conflict < 50) {
    descParts.push(
      `They were picked from the rotation queue. Their conflict score on this topic is ${conflict}/100 — they have some awareness of the topic but not enough to compromise their neutrality.`,
    );
  } else if (conflict < 70) {
    descParts.push(
      `They were picked from the rotation queue. Their conflict score is ${conflict}/100 — moderate but still below the threshold for moderation (anything above 70 gets skipped).`,
    );
  } else {
    descParts.push(
      `Their conflict score is ${conflict}/100, which is unusually high for a moderator. This happens when every available model has a stake in the topic; the forum picked the least compromised option and is disclosing it transparently.`,
    );
  }

  if (skipped.length > 0) {
    const names = skipped.map(s => `${s.modelName} (${s.conflictScore})`).join(', ');
    descParts.push(
      `${skipped.length} ${skipped.length === 1 ? 'model was' : 'models were'} passed over because of a too-high conflict on this topic: ${names}.`,
    );
  }
  if (softcap) {
    descParts.push(
      `The rotation was also adjusted so the last few moderators weren't all from the same lab region — a soft balancing rule that only applies when it doesn't override the conflict check.`,
    );
  }

  return {
    stage: 4,
    stageName: STAGE_NAMES[4],
    step: 'moderator_selected',
    title: `${modelName} is today's moderator`,
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

// --- Stage 5a: Research events ---

function buildResearchEvent(snapshot: ResearchResult & SnapshotMeta): JourneyEvent {
  const factCount = snapshot.synthesisedFacts.length;
  const contestedCount = snapshot.contestedClaims.length;
  const openCount = snapshot.openQuestions.length;

  const descParts: string[] = [];
  descParts.push(
    `Before picking a cast, the moderator reads the available source material on the chosen topic. This first pass works from article summaries and identifies what's known, what's contested, and what's still open. It gives the moderator enough context to pick the right voices for the discussion.`,
  );
  if (factCount > 0 || contestedCount > 0 || openCount > 0) {
    const bits: string[] = [];
    if (factCount > 0) bits.push(`${factCount} established ${factCount === 1 ? 'fact' : 'facts'}`);
    if (contestedCount > 0) bits.push(`${contestedCount} contested ${contestedCount === 1 ? 'claim' : 'claims'}`);
    if (openCount > 0) bits.push(`${openCount} open ${openCount === 1 ? 'question' : 'questions'}`);
    descParts.push(`From this pass the moderator pulled out ${bits.join(', ')}.`);
  }

  return {
    stage: 5,
    stageName: STAGE_NAMES[5],
    step: 'research_complete',
    title: `Moderator read the source material`,
    description: descParts.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      synthesisedFacts: snapshot.synthesisedFacts,
      contestedClaims: snapshot.contestedClaims,
      openQuestions: snapshot.openQuestions,
      timeline: snapshot.timeline,
      overallSummary: snapshot.overallSummary,
      centralItemIds: snapshot.centralItemIds,
    },
  };
}

// --- Stage 5b: Cast selection events ---

function buildCastEvents(
  snapshot: CastSelectionResult & SnapshotMeta,
  sessionType: 'debate' | 'fireside_chat' | null | undefined,
): JourneyEvent[] {
  const events: JourneyEvent[] = [];

  const type = sessionType || snapshot.sessionType;
  const typeLabel = type === 'fireside_chat' ? 'fireside chat' : 'debate';
  const seatCount = snapshot.participants.length;

  // Cast assembled event
  const castDescParts: string[] = [];
  if (type === 'fireside_chat') {
    castDescParts.push(
      `After reading every model's stance on the topic, the moderator concluded that the pool genuinely agrees. Rather than manufacture a fake debate, they picked ${seatCount} of the most interesting aligned voices to sit down together and pressure-test the shared position. This is a fireside chat, not a debate — the moderator probes the consensus rather than forcing opposition.`,
    );
  } else {
    castDescParts.push(
      `The moderator picked ${seatCount} cast members with genuinely opposing positions on the topic. The first seat goes to the model with the most at stake. The second provides the counterweight. If there's a third, it brings a genuinely different angle rather than just another voice. If the moderator couldn't find three distinct views, the debate runs with two — forced third voices dilute the discussion.`,
    );
  }
  if (snapshot.moderatorReasoning) {
    castDescParts.push(`The moderator's reasoning: "${snapshot.moderatorReasoning}"`);
  }
  if (snapshot.error) castDescParts.push(`(Note: cast selection had an issue — ${snapshot.error})`);

  events.push({
    stage: 5,
    stageName: STAGE_NAMES[5],
    step: 'cast_assembled',
    title: type === 'fireside_chat'
      ? `Fireside chat: ${seatCount} aligned voices`
      : `Debate cast: ${seatCount} voices with opposing stances`,
    description: castDescParts.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      sessionType: type,
      participants: snapshot.participants.map((p: CastParticipant) => ({
        modelId: p.modelId,
        modelName: p.modelName,
        provider: p.provider,
        region: p.region,
        seat: p.seat,
        stance: p.stance,
        conflictScore: p.conflictScore,
        conflictReason: p.conflictReason,
        reasoning: p.reasoning,
      })),
      moderatorReasoning: snapshot.moderatorReasoning,
    },
  });

  // Also invited event (only if there are uncast pool members)
  if (snapshot.alsoInvited && snapshot.alsoInvited.length > 0) {
    const n = snapshot.alsoInvited.length;
    events.push({
      stage: 5,
      stageName: STAGE_NAMES[5],
      step: 'also_invited',
      title: `${n} other ${n === 1 ? 'voice was' : 'voices were'} considered`,
      description:
        `Not every model gets a seat, but every model's view gets published. ${n} ${n === 1 ? 'model' : 'models'} in the pool declared a stance on this topic without being picked for the cast. Their positions are still part of the session record — the audience can see who was in the room and what they thought.`,
      timestamp: snapshot._completedAt,
      data: {
        alsoInvited: snapshot.alsoInvited.map((a: AlsoInvitedEntry) => ({
          modelId: a.modelId,
          modelName: a.modelName,
          provider: a.provider,
          stance: a.stance,
          conflictScore: a.conflictScore,
          voteRank: a.voteRank,
        })),
      },
    });
  }

  return events;
}

// --- Stage 5c-i: Deep research event ---

function buildDeepResearchEvent(snapshot: DeepResearchResult & SnapshotMeta): JourneyEvent {
  const dbCount = snapshot.sourceFetches.filter(f => f.text !== null).length;
  const dbTotal = snapshot.sourceFetches.length;
  const webQueries = snapshot.webSearches.length;
  const webResults = snapshot.webSearches.reduce((s, ws) => s + ws.results.length, 0);
  const webRequested = snapshot.webSearchesRequested ?? 0;
  const cap = snapshot.webSearchCap ?? 0;
  const capHit = webRequested > webQueries;

  const dbCitations = snapshot.evidenceSnippets.filter(s => s.citation.type === 'db').length;
  const webCitations = snapshot.evidenceSnippets.filter(s => s.citation.type === 'web').length;

  const descParts: string[] = [];
  descParts.push(
    `With the cast locked in, the moderator does a deeper pass on the source material — fetching the full article text rather than just the summaries. This time they're looking for specifics they can draw on during the discussion: verbatim claims, contested methodology, the things a press release wouldn't include.`,
  );
  if (webQueries > 0) {
    descParts.push(
      `They then go beyond the sources the forum already had. Based on the gaps they identified in the first read, the moderator generates ${webRequested} targeted web search ${webRequested === 1 ? 'query' : 'queries'} — things like independent criticism, expert reactions, counterpoints the original coverage didn't include. ${webResults} pages came back from those searches, all fetched and read.`,
    );
    if (capHit) {
      descParts.push(
        `(The moderator wanted more queries than the current ${cap}-query budget allowed. This is a useful signal that we may want to raise the limit.)`,
      );
    }
  } else {
    descParts.push(`The source material was already comprehensive — no additional web research was needed.`);
  }
  descParts.push(
    `All of that produced ${snapshot.keyClaims.length} key ${snapshot.keyClaims.length === 1 ? 'claim' : 'claims'} backed by specific citations, ${snapshot.evidenceSnippets.length} ${snapshot.evidenceSnippets.length === 1 ? 'verbatim snippet' : 'verbatim snippets'} the moderator can drop into the discussion${webCitations > 0 ? ` (${dbCitations} citing the original sources, ${webCitations} citing external research)` : ''}, and a clear view of what's still unresolved.`,
  );

  return {
    stage: 5,
    stageName: STAGE_NAMES[5],
    step: 'deep_research_complete',
    title: `Moderator went deep — read full articles and researched the gaps`,
    description: descParts.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      dbSourceCount: dbCount,
      dbSourceTotal: dbTotal,
      webQueriesRun: webQueries,
      webQueriesRequested: webRequested,
      webSearchCap: cap,
      capHit,
      webResultsTotal: webResults,
      keyClaims: snapshot.keyClaims,
      evidenceSnippets: snapshot.evidenceSnippets,
      gapsInCoverage: snapshot.gapsInCoverage,
      overallSynthesis: snapshot.overallSynthesis,
      sourceFetches: snapshot.sourceFetches.map(f => ({
        itemId: f.itemId,
        title: f.title,
        sourceName: f.sourceName,
        url: f.url,
        wordCount: f.wordCount,
        success: f.text !== null,
        fetchError: f.fetchError,
      })),
      webSearches: snapshot.webSearches,
    },
  };
}

// --- Stage 5c-ii: Agenda event ---

function buildAgendaEvent(
  snapshot: AgendaBuildResult & SnapshotMeta,
  sessionType: 'debate' | 'fireside_chat' | null | undefined,
): JourneyEvent {
  const segmentCount = snapshot.segments.length;
  const optionalCount = snapshot.optionalDeepening.length;
  const goalCount = snapshot.goals.length;
  const typeLabel = sessionType === 'fireside_chat' ? 'fireside chat' : 'debate';

  const totalMemoryHits = (snapshot.memoryPreload || []).reduce(
    (s, m) => s + (m.exactHits?.length || 0) + (m.familyHits?.length || 0),
    0,
  );

  const descParts: string[] = [];
  descParts.push(
    `With the research done and the cast locked in, the moderator writes the agenda — ${segmentCount} planned ${segmentCount === 1 ? 'segment' : 'segments'} covering the questions today's session needs to work through${optionalCount > 0 ? `, plus ${optionalCount} optional ${optionalCount === 1 ? 'segment' : 'segments'} in reserve if the conversation goes somewhere unexpected` : ''}. Each segment has a main question, a reason it matters, and notes on which cast member to address first.`,
  );
  descParts.push(
    `The agenda is a playbook, not a script. The moderator can follow it in order, follow up on something interesting, pivot to a better line of discussion, or pull back to the plan. The audience sees every decision they make in real time.`,
  );
  if (totalMemoryHits > 0) {
    descParts.push(
      `The moderator also pre-loaded ${totalMemoryHits} past ${totalMemoryHits === 1 ? 'statement' : 'statements'} from the cast members on related topics. If a participant contradicts or echoes something they said in a previous session, the moderator can bring it up directly — "you said this last week, what changed?"`,
    );
  }
  if (snapshot.error) descParts.push(`(Note: agenda build had an issue — ${snapshot.error})`);

  return {
    stage: 5,
    stageName: STAGE_NAMES[5],
    step: 'agenda_built',
    title: `Agenda ready: ${segmentCount} ${segmentCount === 1 ? 'segment' : 'segments'} planned`,
    description: descParts.join(' '),
    timestamp: snapshot._completedAt,
    data: {
      sessionFraming: snapshot.sessionFraming,
      goals: snapshot.goals,
      segments: snapshot.segments.map((s: AgendaSegment) => ({
        name: s.name,
        mainQuestion: s.mainQuestion,
        subQuestions: s.subQuestions,
        participantsToAsk: s.participantsToAsk,
        whyItMatters: s.whyItMatters,
        expectedDuration: s.expectedDuration,
        relatedResearchCount: s.relatedResearch?.length || 0,
        relatedMemoryCount: s.relatedMemory?.length || 0,
      })),
      optionalDeepening: snapshot.optionalDeepening.map((s: AgendaSegment) => ({
        name: s.name,
        mainQuestion: s.mainQuestion,
      })),
      closingFrame: snapshot.closingFrame,
      topicTags: snapshot.topicTags,
      memoryPreloadSummary: (snapshot.memoryPreload || []).map(m => ({
        seat: m.seat,
        modelId: m.modelId,
        modelFamily: m.modelFamily,
        exactHitCount: m.exactHits?.length || 0,
        familyHitCount: m.familyHits?.length || 0,
      })),
    },
  };
}

// --- Stage 6: Debate event ---

function buildDebateEvent(
  snapshot: DebateSnapshot & SnapshotMeta,
  sessionType: 'debate' | 'fireside_chat' | null | undefined,
): JourneyEvent {
  const typeLabel = sessionType === 'fireside_chat' ? 'fireside chat' : 'debate';
  const moveBreakdown = Object.entries(snapshot.moveCounts || {})
    .filter(([, n]) => n > 0)
    .map(([m, n]) => `${m}×${n}`)
    .join(', ');

  const segmentsCovered = (snapshot.segmentProgress || [])
    .filter(sp => sp.status === 'completed').length;
  const segmentsSkipped = (snapshot.segmentProgress || [])
    .filter(sp => sp.status === 'skipped').length;
  const segmentsTotal = (snapshot.segmentProgress || []).length;

  // Which moves were most-used?
  const counterCount = (snapshot.moveCounts || {}).counter_with_opponent || 0;
  const followUpCount = (snapshot.moveCounts || {}).follow_up || 0;
  const memoryCount = (snapshot.moveCounts || {}).surface_memory || 0;
  const changeDirectionCount = (snapshot.moveCounts || {}).change_direction || 0;

  const descParts: string[] = [];
  descParts.push(
    `The session ran for ${snapshot.exchangeTurnCount} exchange ${snapshot.exchangeTurnCount === 1 ? 'turn' : 'turns'}${snapshot.forceCloseApplied ? ' before the hard time cap forced a close' : ' and ended naturally'}.`,
  );

  // Describe what the moderator actually did
  const moveSentences: string[] = [];
  if (counterCount > 0) {
    moveSentences.push(
      `put one cast member on the spot with a claim another had just made ${counterCount} ${counterCount === 1 ? 'time' : 'times'}`,
    );
  }
  if (followUpCount > 0) {
    moveSentences.push(
      `pressed for more detail on an answer ${followUpCount} ${followUpCount === 1 ? 'time' : 'times'}`,
    );
  }
  if (memoryCount > 0) {
    moveSentences.push(
      `surfaced ${memoryCount} past ${memoryCount === 1 ? 'statement' : 'statements'} from a cast member's history`,
    );
  }
  if (changeDirectionCount > 0) {
    moveSentences.push(
      `pivoted to a more productive line of discussion ${changeDirectionCount} ${changeDirectionCount === 1 ? 'time' : 'times'}`,
    );
  }
  if (moveSentences.length > 0) {
    descParts.push(
      `Over those turns the moderator ${moveSentences.join(', ')}. That's what separates a structured discussion from three monologues stitched together.`,
    );
  }

  descParts.push(
    `Of the ${segmentsTotal} planned ${segmentsTotal === 1 ? 'segment' : 'segments'}, ${segmentsCovered} ${segmentsCovered === 1 ? 'was' : 'were'} substantively covered${segmentsSkipped > 0 ? `. The remaining ${segmentsSkipped} ${segmentsSkipped === 1 ? 'was' : 'were'} rolled into other segments or left out because the discussion arrived at the answer organically` : ''}.`,
  );
  descParts.push(
    `Every statement each participant made was tagged and stored in the forum's memory. Future sessions can surface them as contradictions or echoes — a model that said one thing last week will be asked why they said something different today.`,
  );

  if (snapshot.error) descParts.push(`(Note: debate ended with an issue — ${snapshot.error})`);

  return {
    stage: 6,
    stageName: STAGE_NAMES[6],
    step: 'debate_complete',
    title: typeLabel === 'fireside chat'
      ? `Fireside chat ran for ${snapshot.exchangeTurnCount} turns`
      : `Debate ran for ${snapshot.exchangeTurnCount} turns`,
    description: descParts.join(' '),
    timestamp: snapshot._completedAt || snapshot.completedAt,
    data: {
      exchangeTurnCount: snapshot.exchangeTurnCount,
      totalTurnRecords: snapshot.totalTurnRecords,
      moveCounts: snapshot.moveCounts,
      segmentProgress: snapshot.segmentProgress,
      forceCloseApplied: snapshot.forceCloseApplied,
      utterancesStored: snapshot.utterancesStored,
      // Full transcript included for the UI to render drill-down views
      turns: snapshot.turns,
    },
  };
}
