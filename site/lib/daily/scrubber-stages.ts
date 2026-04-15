// ============================================================================
// Forum scrubber stage definitions
// ============================================================================
// Maps the 14 journey event types to 6 user-facing stages shown in the
// scrubber UI. Each scrubber stage represents a coherent phase a new
// visitor can understand — "News scan", "Pool vote", etc. — and can
// contain multiple underlying journey events.
//
// The scrubber renders exactly 6 dots. Clicking a dot expands the
// detail panel showing all events mapped to that stage, each with its
// plain English description + technical-detail expand.
// ============================================================================

export interface ScrubberStage {
  /** 1-6 — visible number on the scrubber dot */
  num: number;
  /** Short label shown under the dot */
  shortTitle: string;
  /** Full title shown in the expanded detail panel */
  fullTitle: string;
  /** One-sentence explanation shown when the stage hasn't happened yet
   *  (e.g. during the scheduled state or when the stage is active but
   *  hasn't produced an event yet). */
  explainer: string;
  /** Event step names that belong to this stage, in expected order.
   *  The detail panel renders whichever of these are present on the
   *  session. Missing events are simply skipped. */
  eventSteps: string[];
}

export const SCRUBBER_STAGES: ScrubberStage[] = [
  {
    num: 1,
    shortTitle: 'News scan',
    fullTitle: 'News scan — the editorial shortlist',
    explainer:
      "Two AI editors independently read through the overnight news and pick the stories worth discussing today. Stories both editors agreed on are strong contenders. Stories only one picked are passed along to the pool as a second opinion.",
    eventSteps: ['session_created', 'organizers_complete', 'merges_applied'],
  },
  {
    num: 2,
    shortTitle: 'Pool vote',
    fullTitle: 'Pool vote — every frontier model weighs in',
    explainer:
      "The shortlist goes to every frontier model from every major lab. Each one votes on which story it thinks matters most today — nothing else. Conflict scores and stances come later, once the topic is chosen and each model is asked to commit to a single subject. This pass is purely a voting ballot.",
    eventSteps: ['pool_responded'],
  },
  {
    num: 3,
    shortTitle: 'Topic & moderator',
    fullTitle: 'Topic & moderator — choosing what to discuss and who runs it',
    explainer:
      "The forum tallies the votes with a top-3 scoring rule and picks the winning story. Ties trigger a runoff. Every pool model is then re-asked about the winning topic — with a strict conflict rubric and an explicit self-veto on the moderator role. A moderator is picked from the rotation queue among the candidates who aren't conflicted and haven't self-vetoed. If nobody passes, the session drops to unmoderated format and says so.",
    eventSteps: [
      'votes_scored',
      'tie_detected',
      'runoff_complete',
      'acting_moderator_chosen',
      'topic_selected',
      'focused_broadcast_complete',
      'moderator_selected',
      'moderator_unavailable',
    ],
  },
  {
    num: 4,
    shortTitle: 'Research & cast',
    fullTitle: 'Research & cast — reading the material and picking the voices',
    explainer:
      "The moderator reads the available source material — enough to understand the substance. Then they pick the cast: 2-3 models from the pool based on their declared positions. For a debate, opposing views. For a fireside chat, aligned voices to pressure-test the consensus together.",
    eventSteps: ['research_complete', 'cast_assembled', 'also_invited'],
  },
  {
    num: 5,
    shortTitle: 'Agenda',
    fullTitle: 'Agenda — deeper research and the debate playbook',
    explainer:
      "With the cast locked in, the moderator goes deeper — fetching full articles, running targeted web searches to find independent perspectives, and building a structured agenda of questions to drive the discussion. The agenda is a playbook, not a script — the moderator can follow or deviate as the session unfolds.",
    eventSteps: ['deep_research_complete', 'agenda_built'],
  },
  {
    num: 6,
    shortTitle: 'Debate',
    fullTitle: 'Debate — the live discussion',
    explainer:
      "The session runs turn by turn. The moderator presses weak answers, counters one voice with another, and occasionally brings up a past statement from a cast member's history. Every participant response is stored so future sessions can hold them accountable for consistency over time.",
    eventSteps: ['debate_complete'],
  },
];

/** For a given session status, return the 1-based stage number the
 *  pipeline is currently working on. Used by the scrubber to highlight
 *  the active dot. */
export function currentScrubberStage(status: string | undefined): number {
  if (!status) return 0;
  const map: Record<string, number> = {
    scheduled: 0,
    in_progress: 1,
    topic_selected: 3,
    moderator_selected: 3,
    researched: 4,
    cast_selected: 4,
    deep_researched: 5,
    agenda_built: 5,
    debate_in_progress: 6,
    completed: 6,
    failed: 0,
  };
  return map[status] ?? 1;
}

/** For a session status, return the number of scrubber stages that have
 *  been COMPLETED (not just started). Used to fill the scrubber's
 *  completed dots. */
export function completedScrubberStages(status: string | undefined): number {
  if (!status) return 0;
  const map: Record<string, number> = {
    scheduled: 0,
    in_progress: 0,
    topic_selected: 2,
    moderator_selected: 3,
    researched: 3,
    cast_selected: 4,
    deep_researched: 4,
    agenda_built: 5,
    debate_in_progress: 5,
    completed: 6,
    failed: 0,
  };
  return map[status] ?? 0;
}
