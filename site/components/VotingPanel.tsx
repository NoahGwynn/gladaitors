// ============================================================================
// VotingPanel — "Who won?" voting on debates (and future content types)
// ============================================================================
// Before vote: shows option buttons (one per debater).
// After vote: shows horizontal bar chart with the viewer's choice highlighted.
// One vote per viewer per piece of content.
// ============================================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Check } from 'lucide-react';
import { getSessionId } from '@/lib/debates';
import { config } from '@/lib/config';
import styles from './VotingPanel.module.scss';

export interface VoteOption {
  /** The value sent to the API — debater_index as a string */
  id: string;
  /** Display name shown on the button and chart */
  name: string;
  /** Hex colour for this option */
  colour: string;
}

interface VotingPanelProps {
  contentId: string;
  contentType: 'debate';
  options: VoteOption[];
}

export default function VotingPanel({ contentId, contentType, options }: VotingPanelProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [votedFor, setVotedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const headers = useCallback(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const sid = getSessionId();
    if (sid) h['x-session-id'] = sid;
    return h;
  }, []);

  // Load existing vote state on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(
        `/api/votes?contentId=${encodeURIComponent(contentId)}&contentType=${encodeURIComponent(contentType)}`,
        { headers: headers() }
      );
      if (cancelled) return;
      if (res.ok) {
        const data = await res.json();
        setCounts(data.counts || {});
        setVotedFor(data.votedFor || null);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [contentId, contentType, headers]);

  async function castVote(optionId: string) {
    if (submitting || votedFor) return;
    setSubmitting(true);
    setError(null);

    const res = await fetch('/api/votes', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ contentId, contentType, votedFor: optionId }),
    });

    if (res.ok) {
      // Optimistically update counts
      setCounts(prev => ({ ...prev, [optionId]: (prev[optionId] || 0) + 1 }));
      setVotedFor(optionId);
    } else if (res.status === 409) {
      // Already voted (e.g. from another tab) — refetch to sync
      const refresh = await fetch(
        `/api/votes?contentId=${encodeURIComponent(contentId)}&contentType=${encodeURIComponent(contentType)}`,
        { headers: headers() }
      );
      if (refresh.ok) {
        const data = await refresh.json();
        setCounts(data.counts || {});
        setVotedFor(data.votedFor || null);
      }
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Failed to cast vote');
    }

    setSubmitting(false);
  }

  if (loading) return null;

  const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className={styles.panel}>
      <span className={styles.title}>
        {votedFor ? 'Who won?' : 'Who do you think won?'}
      </span>

      {!votedFor ? (
        <div className={styles.options}>
          {options.map(opt => (
            <button
              key={opt.id}
              className={styles.option}
              style={{ '--option-colour': opt.colour } as React.CSSProperties}
              onClick={() => castVote(opt.id)}
              disabled={submitting}
            >
              {opt.name}
            </button>
          ))}
        </div>
      ) : config.showSocialMetrics ? (
        <div className={styles.results}>
          {options.map(opt => {
            const count = counts[opt.id] || 0;
            const pct = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
            const isMine = votedFor === opt.id;
            return (
              <div key={opt.id} className={styles.resultRow}>
                <div className={styles.resultLabel}>
                  <span className={styles.resultName} style={{ color: opt.colour }}>
                    {opt.name}
                    {isMine && <span className={styles.yourVote}> · your vote</span>}
                  </span>
                  <span className={styles.resultPct}>{Math.round(pct)}%</span>
                </div>
                <div className={styles.barTrack}>
                  <div
                    className={`${styles.barFill} ${isMine ? styles.barFillMine : ''}`}
                    style={{
                      width: `${pct}%`,
                      background: opt.colour,
                    }}
                  />
                </div>
              </div>
            );
          })}
          <span className={styles.totalVotes}>
            {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
          </span>
        </div>
      ) : (
        (() => {
          const myOption = options.find(o => o.id === votedFor);
          return (
            <div className={styles.thanks}>
              <Check className={styles.thanksCheck} size={32} strokeWidth={2.5} aria-hidden />
              <p className={styles.thanksLine}>
                You voted for{' '}
                <span className={styles.thanksName} style={{ color: myOption?.colour }}>
                  {myOption?.name}
                </span>
              </p>
              <p className={styles.thanksHint}>
                Results will appear once more people have voted.
              </p>
            </div>
          );
        })()
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
