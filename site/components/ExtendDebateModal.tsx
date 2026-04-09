// ============================================================================
// ExtendDebateModal — add more rounds (and an optional moderator note) to a
// completed debate, then resume.
// ============================================================================
// Triggered from the post-debate panel. After the user picks how many extra
// rounds and (optionally) types a moderator note, the parent handles the rest:
// updating the debate record, appending the moderator note, marking the debate
// incomplete, and re-running the orchestrator.
// ============================================================================

'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import styles from './ExtendDebateModal.module.scss';

interface ExtendDebateModalProps {
  /** Current total rounds on the debate. Used to compute the cap. */
  currentRounds: number;
  /** Token cost per round across the AI debaters. Multiplied by extra rounds. */
  tokensPerRound: number;
  /** Current token balance — gates the Extend button if too low. */
  tokenBalance: number | null;
  /** True if any debater is a human player — affects helper text only. */
  hasUserDebater: boolean;
  onClose: () => void;
  onExtend: (extraRounds: number, moderatorNote: string) => Promise<void>;
}

const HARD_CAP = 15;

export default function ExtendDebateModal({
  currentRounds,
  tokensPerRound,
  tokenBalance,
  hasUserDebater,
  onClose,
  onExtend,
}: ExtendDebateModalProps) {
  // The maximum extra rounds available, capped by the 15-round hard limit
  const maxExtra = Math.min(3, HARD_CAP - currentRounds);
  const [extraRounds, setExtraRounds] = useState(Math.min(2, maxExtra));
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cost = extraRounds * tokensPerRound;
  const canAfford = tokenBalance === null || tokenBalance >= cost;
  const canExtend = maxExtra > 0;

  async function handleExtend() {
    if (!canExtend || !canAfford || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onExtend(extraRounds, note.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extend debate');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose}>
          <X size={18} />
        </button>

        <h2 className={styles.title}>Extend this debate</h2>
        <p className={styles.subtitle}>
          Add more rounds and (optionally) inject a thought to redirect the discussion.
        </p>

        {!canExtend ? (
          <p className={styles.cap}>
            This debate has reached the 15-round maximum. It can&apos;t be extended further.
          </p>
        ) : (
          <>
            <div className={styles.field}>
              <label className={styles.label}>How many more rounds?</label>
              <div className={styles.roundButtons}>
                {Array.from({ length: maxExtra }, (_, i) => i + 1).map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`${styles.roundButton} ${extraRounds === n ? styles.roundButtonActive : ''}`}
                    onClick={() => setExtraRounds(n)}
                    disabled={submitting}
                  >
                    +{n}
                  </button>
                ))}
              </div>
              <span className={styles.cap}>
                Total after extension: {currentRounds + extraRounds} of {HARD_CAP} rounds
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Moderator note (optional)</label>
              <textarea
                className={styles.textarea}
                placeholder="e.g. Setting aside the philosophical angle, what about the practical impact?"
                value={note}
                onChange={e => setNote(e.target.value)}
                disabled={submitting}
                rows={3}
                maxLength={500}
              />
              <span className={styles.helperText}>
                Free. The next AI argument will see this as context.
                {hasUserDebater && ' Human debaters will see it inline in the thread.'}
              </span>
            </div>

            <div className={styles.footer}>
              <span className={styles.cost}>
                {cost} {cost === 1 ? 'token' : 'tokens'}
              </span>
              <button
                className={styles.extendButton}
                onClick={handleExtend}
                disabled={!canAfford || submitting}
              >
                {submitting ? 'Extending…' : 'Extend Debate'}
              </button>
            </div>

            {!canAfford && (
              <p className={styles.error}>
                You need {cost - (tokenBalance ?? 0)} more {cost - (tokenBalance ?? 0) === 1 ? 'token' : 'tokens'}.
              </p>
            )}
            {error && <p className={styles.error}>{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
