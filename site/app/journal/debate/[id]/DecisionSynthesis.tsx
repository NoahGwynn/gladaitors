// ============================================================================
// DecisionSynthesis — v3 utility pivot client component
// ============================================================================
// Renders below a completed debate. Three collapsible sections:
//
//   1. What each side surfaced  — auto-generated via POST
//                                 /api/debates/[id]/synthesis the
//                                 first time a logged-in owner views
//                                 their completed debate. Cached on
//                                 the debate row after generation.
//
//   2. What would change my mind — free-text user input, saved via
//                                  /api/debates/[id]/decision.
//                                  Captures the user's own
//                                  falsifiability condition.
//
//   3. Your decision             — optional structured capture of
//                                  what the user actually decided,
//                                  with rationale. Stored for future
//                                  comparison (v3 Commit 3 adds
//                                  version-comparison UI).
//
// Gated: only the debate owner sees input UIs. Non-owners viewing a
// public debate see the synthesis (if generated) but not the user's
// "what would change my mind" text or recorded decision — those are
// private reflective fields.
// ============================================================================

'use client';

import { useState, useEffect } from 'react';
import styles from './DecisionSynthesis.module.scss';

interface SynthesisSide {
  seat: number;
  modelName: string;
  position: string;
  strongestPoints: string[];
}

interface DecisionSynthesisData {
  eachSideSurfaced: SynthesisSide[];
  tensions: string[];
  summary: string;
  generatedAt: string;
  synthesisModelId: string;
}

interface UserDecision {
  decision: string;
  rationale: string;
  timestamp: string;
}

interface DecisionSynthesisProps {
  debateId: string;
  isOwner: boolean;
  initialSynthesis: DecisionSynthesisData | null;
  initialWhatWouldChangeMyMind: string | null;
  initialUserDecision: UserDecision | null;
}

export default function DecisionSynthesis({
  debateId,
  isOwner,
  initialSynthesis,
  initialWhatWouldChangeMyMind,
  initialUserDecision,
}: DecisionSynthesisProps) {
  const [synthesis, setSynthesis] = useState<DecisionSynthesisData | null>(initialSynthesis);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [whatWouldChangeMyMind, setWhatWouldChangeMyMind] = useState(
    initialWhatWouldChangeMyMind || '',
  );
  const [wwcmSaving, setWwcmSaving] = useState(false);
  const [wwcmSaved, setWwcmSaved] = useState(false);

  const [showDecisionForm, setShowDecisionForm] = useState(!!initialUserDecision);
  const [decisionText, setDecisionText] = useState(initialUserDecision?.decision || '');
  const [rationaleText, setRationaleText] = useState(initialUserDecision?.rationale || '');
  const [decisionSaved, setDecisionSaved] = useState<UserDecision | null>(initialUserDecision);
  const [decisionSaving, setDecisionSaving] = useState(false);

  // Auto-generate synthesis on first mount for owners who don't have
  // one yet. Non-owners don't trigger generation.
  useEffect(() => {
    if (!isOwner) return;
    if (synthesis) return;
    generateSynthesis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generateSynthesis() {
    if (generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/debates/${debateId}/synthesis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        setGenerateError(data.error || 'Failed to generate synthesis');
        return;
      }
      setSynthesis(data.synthesis);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setGenerating(false);
    }
  }

  async function saveWhatWouldChangeMyMind() {
    if (wwcmSaving) return;
    setWwcmSaving(true);
    try {
      const res = await fetch(`/api/debates/${debateId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatWouldChangeMyMind }),
      });
      if (res.ok) {
        setWwcmSaved(true);
        setTimeout(() => setWwcmSaved(false), 2000);
      }
    } finally {
      setWwcmSaving(false);
    }
  }

  async function saveDecision() {
    if (decisionSaving) return;
    if (!decisionText.trim()) return;
    setDecisionSaving(true);
    try {
      const res = await fetch(`/api/debates/${debateId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: { decision: decisionText, rationale: rationaleText },
        }),
      });
      if (res.ok) {
        setDecisionSaved({
          decision: decisionText,
          rationale: rationaleText,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      setDecisionSaving(false);
    }
  }

  // Non-owners without a synthesis see nothing
  if (!isOwner && !synthesis) return null;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.label}>Decision synthesis</span>
        <span className={styles.sublabel}>
          The debate is the evidence. This is what you do with it.
        </span>
      </div>

      {/* ======================================================== */}
      {/* 1. Auto-generated synthesis                              */}
      {/* ======================================================== */}
      {generating && (
        <div className={styles.generatingBox}>
          <span className={styles.spinnerDot} />
          Generating synthesis — reading the full debate and extracting the
          strongest points on each side, the open tensions, and a summary.
          This takes 15-30 seconds.
        </div>
      )}

      {generateError && (
        <div className={styles.errorBox}>
          Couldn&apos;t generate the synthesis: {generateError}
          {isOwner && (
            <button type="button" onClick={generateSynthesis} className={styles.retryButton}>
              Retry
            </button>
          )}
        </div>
      )}

      {synthesis && (
        <>
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Summary</h3>
            <p className={styles.summary}>{synthesis.summary}</p>
          </div>

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>What each side surfaced</h3>
            <div className={styles.sidesGrid}>
              {synthesis.eachSideSurfaced.map((side) => (
                <div key={side.seat} className={styles.sideCard}>
                  <div className={styles.sideHeader}>
                    <div className={styles.sideModelName}>{side.modelName}</div>
                    <div className={styles.sidePosition}>{side.position}</div>
                  </div>
                  <ul className={styles.sidePoints}>
                    {side.strongestPoints.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {synthesis.tensions.length > 0 && (
            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Open tensions</h3>
              <p className={styles.sectionHint}>
                The questions whose answers would meaningfully shift your decision. If you can answer them, the call gets clearer.
              </p>
              <ol className={styles.tensions}>
                {synthesis.tensions.map((tension, i) => (
                  <li key={i}>{tension}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}

      {/* ======================================================== */}
      {/* 2. What would change my mind — owner-only input          */}
      {/* ======================================================== */}
      {isOwner && synthesis && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>What would change your mind?</h3>
          <p className={styles.sectionHint}>
            Before you act, name the evidence or argument that would actually shift your position. Writing it down makes you more honest about your own falsifiability.
          </p>
          <textarea
            className={styles.textarea}
            value={whatWouldChangeMyMind}
            onChange={(e) => setWhatWouldChangeMyMind(e.target.value)}
            onBlur={saveWhatWouldChangeMyMind}
            placeholder="e.g. If I saw three counterexamples where the same approach failed on teams our size, I'd reconsider."
            maxLength={4000}
            rows={3}
          />
          <div className={styles.saveRow}>
            <button type="button" className={styles.saveButton} onClick={saveWhatWouldChangeMyMind} disabled={wwcmSaving}>
              {wwcmSaving ? 'Saving…' : wwcmSaved ? 'Saved ✓' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 3. Your decision — owner-only, optional                  */}
      {/* ======================================================== */}
      {isOwner && synthesis && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Your decision</h3>
          {!showDecisionForm && !decisionSaved && (
            <>
              <p className={styles.sectionHint}>
                Optional: record what you actually decided, with a short rationale. Future-you will want to compare against it when revisiting the same decision.
              </p>
              <button type="button" className={styles.saveButton} onClick={() => setShowDecisionForm(true)}>
                Record your decision
              </button>
            </>
          )}
          {(showDecisionForm || decisionSaved) && (
            <>
              <label className={styles.inputLabel}>What did you decide?</label>
              <input
                type="text"
                className={styles.input}
                value={decisionText}
                onChange={(e) => setDecisionText(e.target.value)}
                placeholder="e.g. Launch in UK first, delay EU by 6 weeks."
                maxLength={1000}
              />
              <label className={styles.inputLabel}>Why?</label>
              <textarea
                className={styles.textarea}
                value={rationaleText}
                onChange={(e) => setRationaleText(e.target.value)}
                placeholder="The strongest counter-arguments were around compliance risk, but we can ship UK-first and learn before committing EU resources."
                maxLength={4000}
                rows={3}
              />
              <div className={styles.saveRow}>
                <button
                  type="button"
                  className={styles.saveButton}
                  onClick={saveDecision}
                  disabled={decisionSaving || !decisionText.trim()}
                >
                  {decisionSaving ? 'Saving…' : decisionSaved ? 'Update' : 'Save decision'}
                </button>
                {decisionSaved && (
                  <span className={styles.savedAt}>
                    Last saved {new Date(decisionSaved.timestamp).toLocaleString()}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
