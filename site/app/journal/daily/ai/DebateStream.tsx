// ============================================================================
// DebateStream — turn-by-turn transcript viewer
// ============================================================================
// Renders the full debate transcript from debate_snapshot.turns. Used in
// two states:
//
//   - Live (status=debate_in_progress) — new turns stream in via
//     Supabase Realtime as the runtime persists each one. Auto-scrolls
//     to the latest turn. Shows a pulsing "live" indicator.
//   - Complete (status=completed) — the full record, no pulse, no scroll
//
// Each turn card mirrors the Arena's argument pattern: a left-accent
// stripe in the provider's color, with the model name, move label
// (for moderator turns), and spoken text.
//
// Moderator turns show their reasoning in a collapsible block so
// readers can see not just what the moderator said but why they
// picked that move.
// ============================================================================

'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { MODERATOR_COLOR, getProviderColor } from '@/lib/daily/session-colors';
import type { TurnFlag } from '@/lib/daily/turn-flags';
import { Check, RotateCw, ShieldAlert, Loader2 } from 'lucide-react';
import styles from './page.module.scss';

// --- Types (matches what debate-runtime.ts persists) ---

interface DebateTurn {
  index: number;
  exchangeTurn: number;
  actor: 'moderator' | 'participant';
  timestamp: string;
  move?: string;
  targetSeat?: number | null;
  moderatorReasoning?: string;
  forcedClose?: boolean;
  seat?: number;
  modelId?: string;
  modelName?: string;
  text: string;
  segmentName?: string | null;
}

interface DebateSnapshot {
  status: 'in_progress' | 'completed' | 'failed';
  exchangeTurnCount: number;
  totalTurnRecords: number;
  forceCloseApplied?: boolean;
  turns: DebateTurn[];
  utterancesStored?: number;
}

interface CastMember {
  seat: number;
  modelName: string;
  provider: string;
}

interface ModeratorInfo {
  modelId: string;
  modelName: string;
  provider: string;
}

interface DebateStreamProps {
  snapshot: DebateSnapshot;
  sessionType: 'debate' | 'fireside_chat' | null;
  topicTitle: string;
  /** Null for unmoderated sessions — the roster renders without a
   *  moderator row and an explanatory banner is shown instead. */
  moderator: ModeratorInfo | null;
  cast: CastMember[];
  /** True while the debate is still running (shows live indicator + auto-scroll) */
  live: boolean;
  debateFormat?: 'moderated' | 'unmoderated';
  unmoderatedReason?: string | null;
  /** Per-turn moderation flags. Map<turn.index, TurnFlag>. Optional —
   *  pages that don't go through moderation just pass undefined and
   *  every turn renders normally. */
  turnFlags?: Map<number, TurnFlag>;
  /** True when the current viewer is an admin/operator. Admins always
   *  see flagged turn bodies + per-turn approve/rerun controls. */
  isAdmin?: boolean;
  /** Forum session id — needed for the admin approve/rerun API calls.
   *  Required when isAdmin is true. */
  sessionId?: string;
}

export default function DebateStream({
  snapshot,
  sessionType,
  topicTitle,
  moderator,
  cast,
  live,
  debateFormat = 'moderated',
  unmoderatedReason = null,
  turnFlags,
  isAdmin = false,
  sessionId,
}: DebateStreamProps) {
  const turnsEndRef = useRef<HTMLDivElement>(null);
  const turnCount = snapshot.turns.length;

  // Auto-scroll to the latest turn during live streaming
  useEffect(() => {
    if (live && turnsEndRef.current) {
      turnsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [turnCount, live]);

  // Build a seat → provider/color lookup from the cast
  const castBySeat = new Map<number, CastMember>();
  for (const c of cast) castBySeat.set(c.seat, c);

  const sessionTypeLabel = debateFormat === 'unmoderated'
    ? 'Unmoderated debate'
    : sessionType === 'fireside_chat' ? 'Fireside Chat' : 'Debate';

  return (
    <div className={styles.debateWrap}>
      <div className={styles.debateHeader}>
        <div className={styles.debateSessionType}>{sessionTypeLabel}</div>
        <h2 className={styles.debateTopic}>{topicTitle}</h2>

        {debateFormat === 'unmoderated' && (
          <div className={styles.debateUnmoderatedBanner}>
            <strong>No moderator today.</strong>{' '}
            {unmoderatedReason
              || 'No pool model was clean enough to chair this topic. The panelists speak directly in sequence, without a referee.'}
          </div>
        )}

        <div className={styles.debateRoster}>
          {moderator && (
            <div className={styles.debateRosterRow}>
              <span className={styles.debateRosterLabel}>Moderator</span>
              <span
                className={styles.debateCastMember}
                style={{ '--seat-color': MODERATOR_COLOR } as CSSProperties}
              >
                <span className={styles.debateCastDot} />
                <strong>{moderator.modelName}</strong>
              </span>
            </div>
          )}
          <div className={styles.debateRosterRow}>
            <span className={styles.debateRosterLabel}>
              {sessionType === 'fireside_chat' ? 'Voices' : 'Panelists'}
            </span>
            {cast.map((c) => (
              <span
                key={c.seat}
                className={styles.debateCastMember}
                style={{ '--seat-color': getProviderColor(c.provider) } as CSSProperties}
              >
                <span className={styles.debateCastDot} />
                <span>
                  Seat {c.seat}: <strong>{c.modelName}</strong>
                </span>
              </span>
            ))}
          </div>
        </div>

        {live && (
          <div className={styles.debateStatus}>
            <span className={styles.debateStatusDot} />
            Live — {snapshot.exchangeTurnCount} turn{snapshot.exchangeTurnCount === 1 ? '' : 's'}
          </div>
        )}
      </div>

      <div className={styles.debateTurns}>
        {snapshot.turns.map((turn) => (
          <DebateTurnCard
            key={turn.index}
            turn={turn}
            castBySeat={castBySeat}
            moderatorName={moderator?.modelName ?? null}
            flag={turnFlags?.get(turn.index) ?? null}
            isAdmin={isAdmin}
            sessionId={sessionId}
          />
        ))}
        <div ref={turnsEndRef} />
      </div>
    </div>
  );
}

// --- Individual turn card ---

interface DebateTurnCardProps {
  turn: DebateTurn;
  castBySeat: Map<number, CastMember>;
  moderatorName: string | null;
  flag: TurnFlag | null;
  isAdmin: boolean;
  sessionId?: string;
}

function DebateTurnCard({ turn, castBySeat, moderatorName, flag, isAdmin, sessionId }: DebateTurnCardProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);

  // Decide what body to render. Three states:
  //   1. Hidden for the public — flagged + no decision yet + not admin.
  //      We show a placeholder card explaining the message is held.
  //   2. Visible with chrome — flagged but viewer is admin OR the
  //      operator has resolved (approved/rerun). Body shows normally;
  //      admin gets the finding details + approve/rerun controls inline.
  //   3. Plain — no findings on this turn. Renders as before.
  const hasUnresolved = flag && flag.criticalFindings.length > 0 && flag.decision === null;
  const hideForPublic = hasUnresolved && !isAdmin;

  // Common header pieces (built once, used by both moderator + participant branches).
  const isModerator = turn.actor === 'moderator';
  const castMember = !isModerator && turn.seat != null ? castBySeat.get(turn.seat) : null;
  const color = isModerator
    ? MODERATOR_COLOR
    : (castMember ? getProviderColor(castMember.provider) : '#8e8eae');
  const cardClass = `${styles.turn} ${isModerator ? styles.turnModerator : ''} ${hasUnresolved ? styles.turnFlagged : ''}`.trim();

  function header() {
    if (isModerator) {
      return (
        <div className={styles.turnHeader}>
          <span className={`${styles.turnActor} ${styles.turnActorModerator}`}>
            {moderatorName ? `Moderator · ${moderatorName}` : 'Moderator'}
          </span>
          {turn.move && <span className={styles.turnMove}>{turn.move}</span>}
          {turn.targetSeat != null && (
            <span className={styles.turnTarget}>→ Seat {turn.targetSeat}</span>
          )}
          <span className={styles.turnNumber}>Turn {turn.exchangeTurn + 1}</span>
        </div>
      );
    }
    return (
      <div className={styles.turnHeader}>
        <span className={styles.turnActor} style={{ color }}>
          {turn.modelName || castMember?.modelName || `Seat ${turn.seat}`}
        </span>
        <span className={styles.turnTarget}>Seat {turn.seat}</span>
        <span className={styles.turnNumber}>Turn {turn.exchangeTurn + 1}</span>
      </div>
    );
  }

  function moderatorReasoningBlock() {
    if (!isModerator || !turn.moderatorReasoning) return null;
    return (
      <>
        <button
          type="button"
          className={styles.turnReasoningToggle}
          onClick={() => setReasoningOpen((o) => !o)}
        >
          {reasoningOpen ? '▾ Hide reasoning' : '▸ Why this move'}
        </button>
        {reasoningOpen && (
          <div className={styles.turnReasoning}>{turn.moderatorReasoning}</div>
        )}
      </>
    );
  }

  // 1. Hidden-for-public state.
  if (hideForPublic && flag) {
    return (
      <div
        className={cardClass}
        style={{ '--turn-color': color } as CSSProperties}
      >
        {header()}
        <div className={styles.turnHeldPlaceholder}>
          <ShieldAlert size={16} />
          <span>
            This message is held pending operator review. The rest of the
            debate is unaffected — the moderation pipeline flagged just
            this passage. Skipping is always acceptable; a clean dAIly
            beats a fast one.
          </span>
        </div>
      </div>
    );
  }

  // 2 + 3. Visible body. If admin AND flagged, layer on the finding
  // details + approve/rerun controls.
  return (
    <div
      className={cardClass}
      style={{ '--turn-color': color } as CSSProperties}
    >
      {header()}
      {moderatorReasoningBlock()}
      <div className={styles.turnContent}>{turn.text}</div>
      {isAdmin && flag && (flag.criticalFindings.length > 0 || flag.decision) && (
        <AdminTurnPanel
          flag={flag}
          turnIndex={turn.index}
          sessionId={sessionId}
        />
      )}
    </div>
  );
}

// --- Admin per-turn panel: finding details + approve/rerun controls ---

interface AdminTurnPanelProps {
  flag: TurnFlag;
  turnIndex: number;
  sessionId?: string;
}

function AdminTurnPanel({ flag, turnIndex, sessionId }: AdminTurnPanelProps) {
  const [busy, setBusy] = useState<'approve' | 'rerun' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: 'approve' | 'rerun') {
    if (!sessionId) {
      setError('Missing session id — page reload required.');
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(
        `/api/daily/sessions/${sessionId}/turns/${turnIndex}/${action}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Request failed (${res.status})`);
      }
      // The Realtime subscription on the page will pick up the
      // updated session row and re-render with the new decision.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  // Already actioned — show the resolution, no buttons.
  if (flag.decision) {
    return (
      <div className={styles.adminTurnPanel} data-resolved="true">
        <div className={styles.adminTurnPanelHeader}>
          {flag.decision.action === 'approved' ? (
            <>
              <Check size={14} />
              <span>Approved — kept as-is after operator review</span>
            </>
          ) : (
            <>
              <RotateCw size={14} />
              <span>Rephrased to address the finding</span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.adminTurnPanel}>
      <div className={styles.adminTurnPanelHeader}>
        <ShieldAlert size={14} />
        <span>
          {flag.criticalFindings.length} critical finding{flag.criticalFindings.length === 1 ? '' : 's'} on this turn
        </span>
      </div>
      <ul className={styles.adminTurnFindings}>
        {flag.criticalFindings.map((f, i) => (
          <li key={i}>
            <span className={styles.adminTurnFindingCheck}>{f.check}</span>
            <span className={styles.adminTurnFindingIssue}>{f.issue}</span>
            {f.rationale && (
              <span className={styles.adminTurnFindingRationale}>{f.rationale}</span>
            )}
            {f.suggestion && (
              <span className={styles.adminTurnFindingSuggestion}>
                <strong>Suggestion:</strong> {f.suggestion}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className={styles.adminTurnActions}>
        <button
          type="button"
          className={styles.adminTurnApprove}
          onClick={() => call('approve')}
          disabled={busy !== null}
        >
          {busy === 'approve' ? <Loader2 size={14} className={styles.adminTurnSpinner} /> : <Check size={14} />}
          Approve as-is
        </button>
        <button
          type="button"
          className={styles.adminTurnRerun}
          onClick={() => call('rerun')}
          disabled={busy !== null}
        >
          {busy === 'rerun' ? <Loader2 size={14} className={styles.adminTurnSpinner} /> : <RotateCw size={14} />}
          Rephrase to fix
        </button>
      </div>
      {error && <div className={styles.adminTurnError}>{error}</div>}
    </div>
  );
}
