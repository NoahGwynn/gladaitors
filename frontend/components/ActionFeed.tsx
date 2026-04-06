// ============================================================================
// ActionFeed — scrolling chat-style action history
// ============================================================================
// Shows a chronological feed of model actions with reasoning.
// New entries appear at the bottom and the feed auto-scrolls.
// Each entry is colour-coded by model.
//
// Usage:
//   <ActionFeed entries={actionHistory} />
// ============================================================================

'use client';

import { useEffect, useRef } from 'react';
import styles from './ActionFeed.module.scss';

export interface ActionEntry {
  id: string;
  modelId: string;
  modelName: string;
  round: number;
  status: 'thinking' | 'active' | 'skip';
  actions: Array<{
    type: string;
    detail: string;
    reasoning: string;
  }>;
  error?: string;
}

interface ActionFeedProps {
  entries: ActionEntry[];
}

export default function ActionFeed({ entries }: ActionFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new entries appear
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className={styles.feed} ref={feedRef}>
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`${styles.entry} ${styles[entry.modelId] || ''}`}
        >
          <div className={styles.entryHeader}>
            <span className={styles.modelName}>{entry.modelName}</span>
            <span className={styles.turnLabel}>R{entry.round}</span>
          </div>

          {entry.status === 'thinking' && (
            <div className={styles.action}>Thinking...</div>
          )}

          {entry.status === 'skip' && (
            <div className={styles.skip}>
              Turn skipped{entry.error ? ` — ${entry.error}` : ''}
            </div>
          )}

          {entry.status === 'active' && (
            <div className={styles.actions}>
              {entry.actions.map((action, i) => (
                <div key={i} className={styles.action}>
                  <span className={styles.actionType}>{action.type}</span>
                  {action.detail}
                  {action.reasoning && (
                    <span className={styles.reasoning}> — {action.reasoning}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
