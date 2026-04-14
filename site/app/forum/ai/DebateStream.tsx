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
import { MODERATOR_COLOR, getProviderColor } from '@/lib/forum/session-colors';
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

interface DebateStreamProps {
  snapshot: DebateSnapshot;
  sessionType: 'debate' | 'fireside_chat' | null;
  topicTitle: string;
  cast: CastMember[];
  /** True while the debate is still running (shows live indicator + auto-scroll) */
  live: boolean;
}

export default function DebateStream({
  snapshot,
  sessionType,
  topicTitle,
  cast,
  live,
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

  const sessionTypeLabel =
    sessionType === 'fireside_chat' ? 'Fireside Chat' : 'Debate';

  return (
    <div className={styles.debateWrap}>
      <div className={styles.debateHeader}>
        <div className={styles.debateSessionType}>{sessionTypeLabel}</div>
        <h2 className={styles.debateTopic}>{topicTitle}</h2>
        <div className={styles.debateCast}>
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
}

function DebateTurnCard({ turn, castBySeat }: DebateTurnCardProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);

  if (turn.actor === 'moderator') {
    return (
      <div
        className={`${styles.turn} ${styles.turnModerator}`}
        style={{ '--turn-color': MODERATOR_COLOR } as CSSProperties}
      >
        <div className={styles.turnHeader}>
          <span className={`${styles.turnActor} ${styles.turnActorModerator}`}>
            Moderator
          </span>
          {turn.move && <span className={styles.turnMove}>{turn.move}</span>}
          {turn.targetSeat != null && (
            <span className={styles.turnTarget}>→ Seat {turn.targetSeat}</span>
          )}
          <span className={styles.turnNumber}>Turn {turn.exchangeTurn + 1}</span>
        </div>
        {turn.moderatorReasoning && (
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
        )}
        <div className={styles.turnContent}>{turn.text}</div>
      </div>
    );
  }

  // Participant turn
  const castMember = turn.seat != null ? castBySeat.get(turn.seat) : null;
  const color = castMember ? getProviderColor(castMember.provider) : '#8e8eae';

  return (
    <div
      className={styles.turn}
      style={{ '--turn-color': color } as CSSProperties}
    >
      <div className={styles.turnHeader}>
        <span className={styles.turnActor} style={{ color }}>
          {turn.modelName || castMember?.modelName || `Seat ${turn.seat}`}
        </span>
        <span className={styles.turnTarget}>Seat {turn.seat}</span>
        <span className={styles.turnNumber}>Turn {turn.exchangeTurn + 1}</span>
      </div>
      <div className={styles.turnContent}>{turn.text}</div>
    </div>
  );
}
