// ============================================================================
// UserTurnInput — input UI for human player turns inside a debate
// ============================================================================
// Renders inline in the debate thread when it's a 'user' slot's turn. The user
// types their argument and either:
//   - clicks "Submit Argument" → continue the debate normally
//   - clicks "End debate" / "End after this round" → submit this argument as
//     the final user turn and stop the debate
//
// The end button's label depends on whether this user is the LAST debater in
// the current round:
//   - Last in round: "End debate now" — round wraps with this argument
//   - Not last:      "End debate after this round" — remaining AI debaters
//                    will still finish the round before the debate stops
// ============================================================================

'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import styles from './UserTurnInput.module.scss';

interface UserTurnInputProps {
  /** The display label for this user slot — e.g. "Human" or "Human 1" */
  displayName: string;
  /** The user's assigned position, shown above the textarea as a reminder */
  position: string;
  /** The model brand colour (gold) used for the card border */
  colour: string;
  /** True if this user slot is the last debater in the round (changes End button label) */
  isLastInRound: boolean;
  /** Submit handler. `intent` tells the parent whether to continue the debate
   *  or end it after this argument. Returns a result object so we can show
   *  inline errors (e.g. safety check blocks). */
  onSubmit: (
    text: string,
    intent: 'continue' | 'end',
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const SOFT_WORD_LIMIT = 250;

export default function UserTurnInput({ displayName, position, colour, isLastInRound, onSubmit }: UserTurnInputProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const isValid = trimmed.length > 0;

  async function handleSubmit(intent: 'continue' | 'end') {
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(trimmed, intent);
    if (result.ok) {
      // Parent will replace this component with the rendered argument.
      // Don't reset state — component will unmount.
    } else {
      setError(result.error);
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit('continue');
    }
  }

  const endButtonLabel = isLastInRound ? 'End debate now' : 'End after this round';

  return (
    <div
      className={styles.card}
      style={{ '--user-colour': colour } as React.CSSProperties}
    >
      <div className={styles.header}>
        <span className={styles.headerName}>{displayName}</span>
        <span className={styles.headerPosition}>{position}</span>
      </div>

      <textarea
        className={styles.textarea}
        placeholder="Write your argument here..."
        value={text}
        onChange={e => { setText(e.target.value); setError(null); }}
        onKeyDown={handleKeyDown}
        disabled={submitting}
        rows={6}
        autoFocus
      />

      <div className={styles.footer}>
        <span className={`${styles.wordCount} ${wordCount > SOFT_WORD_LIMIT ? styles.wordCountOver : ''}`}>
          {wordCount} {wordCount === 1 ? 'word' : 'words'}
          {wordCount > SOFT_WORD_LIMIT && ` · over ${SOFT_WORD_LIMIT}`}
        </span>
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.endButton}
            onClick={() => handleSubmit('end')}
            disabled={!isValid || submitting}
            title="Submit this as your final argument"
          >
            {endButtonLabel}
          </button>
          <button
            type="button"
            className={styles.submit}
            onClick={() => handleSubmit('continue')}
            disabled={!isValid || submitting}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className={styles.spinner} />
                Checking…
              </>
            ) : (
              'Submit Argument'
            )}
          </button>
        </div>
      </div>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
