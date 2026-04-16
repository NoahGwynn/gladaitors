// ============================================================================
// Turn-flag derivation for the operator review UI
// ============================================================================
// Per-turn surgical hold: instead of blanking the entire debate when
// a screening check raises a critical finding, only the specific
// turns that the findings refer to are blanked. Other turns publish
// normally.
//
// This module derives, for each turn in a session, whether it should
// be hidden, why, and (if the operator is logged in) what action is
// available. The derivation is read-only — admin actions are persisted
// to forum_sessions.turn_decisions via separate API routes.
// ============================================================================

import type { ModerationFinding, ModerationPipelineResult } from './moderation-pipeline';

/** Operator decision recorded against a single turn. */
export interface TurnDecision {
  /** What the operator did with this turn. */
  action: 'approved' | 'rerun';
  /** UUID of the admin who made the call. */
  byUserId: string;
  /** ISO timestamp of the action. */
  atIso: string;
  /** When action='rerun', the original (pre-regenerated) text — kept
   *  so the operator can revert if the rerun made things worse. */
  originalText?: string;
}

/** Map keyed by turn index (as string for JSON-friendliness). */
export type TurnDecisionsMap = Record<string, TurnDecision>;

/** Synthesised view of a single turn's moderation state for the UI. */
export interface TurnFlag {
  /** All critical findings bound to this turn (turnIndex matches). */
  criticalFindings: ModerationFinding[];
  /** All minor findings bound to this turn (informational only — do
   *  not affect display gating). */
  minorFindings: ModerationFinding[];
  /** Operator's decision on this turn, if any. */
  decision: TurnDecision | null;
  /** True when the turn's body should be hidden from non-admin users.
   *  False when there are no unresolved critical findings on it (no
   *  findings at all, or all approved/reworded). */
  hiddenForPublic: boolean;
}

/** Whether the session has any unresolved critical findings — i.e.
 *  whether there's still work for the operator to do before the
 *  session can publish. Used by the auto-publish logic. */
export function hasUnresolvedCriticalFindings(
  moderation: ModerationPipelineResult | null | undefined,
  decisions: TurnDecisionsMap | null | undefined,
): boolean {
  if (!moderation) return false;
  const decisionsByIndex = decisions || {};
  for (const check of moderation.checks) {
    for (const finding of check.findings) {
      if (finding.severity !== 'critical') continue;
      // Session-level findings (no turnIndex) are always unresolved
      // until the operator either fixes them session-wide or accepts
      // them — for now they always block.
      if (finding.turnIndex == null) return true;
      // A turn-bound finding is resolved if the operator has approved
      // or rerun that turn. Both actions clear any findings on the
      // turn — approve = "I judged this fine after review", rerun =
      // "the new text doesn't have this issue".
      if (!decisionsByIndex[String(finding.turnIndex)]) return true;
    }
  }
  return false;
}

/** Whether the session has session-level critical findings (findings
 *  with turnIndex=null). Those can't be fixed per-turn — the operator
 *  has to accept them session-wide via the legacy approve. Until
 *  then, the whole debate body stays hidden for non-admins. */
export function hasSessionLevelCriticals(
  moderation: ModerationPipelineResult | null | undefined,
): boolean {
  if (!moderation) return false;
  for (const check of moderation.checks) {
    for (const finding of check.findings) {
      if (finding.severity === 'critical' && finding.turnIndex == null) return true;
    }
  }
  return false;
}

/** Build a per-turn flag map for fast lookup in the renderer. Pass
 *  `isAdmin: true` to keep `hiddenForPublic` reflecting public state
 *  (the renderer decides whether to actually hide based on isAdmin). */
export function buildTurnFlags(
  moderation: ModerationPipelineResult | null | undefined,
  decisions: TurnDecisionsMap | null | undefined,
): Map<number, TurnFlag> {
  const flags = new Map<number, TurnFlag>();
  if (!moderation) return flags;
  const decisionsByIndex = decisions || {};

  for (const check of moderation.checks) {
    for (const finding of check.findings) {
      if (finding.turnIndex == null) continue;
      const idx = finding.turnIndex;
      let flag = flags.get(idx);
      if (!flag) {
        flag = {
          criticalFindings: [],
          minorFindings: [],
          decision: decisionsByIndex[String(idx)] ?? null,
          hiddenForPublic: false,
        };
        flags.set(idx, flag);
      }
      if (finding.severity === 'critical') flag.criticalFindings.push(finding);
      else flag.minorFindings.push(finding);
    }
  }

  // Compute hiddenForPublic now that all findings are gathered.
  for (const flag of flags.values()) {
    flag.hiddenForPublic = flag.criticalFindings.length > 0 && flag.decision === null;
  }

  return flags;
}
