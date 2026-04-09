// ============================================================================
// /explore — public feed of debates that creators have opted to list
// ============================================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { findModel, getModelColour, getModelName } from '@/lib/models';
import { config } from '@/lib/config';
import styles from './page.module.scss';

interface FeedDebate {
  id: string;
  topic: string;
  models: string[];
  positions: Record<string, string>;
  viewCount: number;
  voteCount: number;
  argumentCount: number;
  createdAt: string;
  preview: string | null;
}

type SortMode = 'recent' | 'votes' | 'views';

/** Hand-picked starter topics shown in the empty-state grid. Mix of playful,
 *  pop-culture, philosophical, and practical so the empty state demonstrates
 *  the platform's range. Avoiding politics by design — empty state should
 *  feel friendly, not divisive. */
const EXAMPLE_TOPICS: string[] = [
  'Is cereal soup?',
  'Is a hot dog a sandwich?',
  'Are dogs better than cats?',
  'Was Star Wars more important than Star Trek?',
  'Is free will an illusion?',
  'Should we have a four-day work week?',
];

/** Display name disambiguation for duplicates / user slots */
function getDisplayNames(modelIds: string[]): string[] {
  const counts: Record<string, number> = {};
  modelIds.forEach(id => { counts[id] = (counts[id] || 0) + 1; });

  const seen: Record<string, number> = {};
  return modelIds.map(id => {
    const model = findModel(id);
    const base = model?.family === 'user' ? 'Human' : getModelName(id);
    if (counts[id] === 1) return base;
    seen[id] = (seen[id] || 0) + 1;
    return `${base} ${seen[id]}`;
  });
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ExplorePage() {
  const [sort, setSort] = useState<SortMode>('recent');
  const [debates, setDebates] = useState<FeedDebate[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (sortMode: SortMode) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/debates/public?sort=${sortMode}&limit=30`);
      if (res.ok) {
        const data = await res.json();
        setDebates(data.debates || []);
      }
    } catch {
      setDebates([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(sort);
  }, [sort, load]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Watch the models argue.</h1>
        <p className={styles.subtitle}>
          Claude, GPT-4o, and Gemini take sides on your topics. Vote on who made the better case.
        </p>
        <Link href="/arena/debate" className={styles.headerCta}>
          Start your own debate →
        </Link>
      </header>

      {config.showSocialMetrics && (
        <div className={styles.sortBar}>
          {(['recent', 'votes', 'views'] as SortMode[]).map(mode => (
            <button
              key={mode}
              className={`${styles.sortButton} ${sort === mode ? styles.sortButtonActive : ''}`}
              onClick={() => setSort(mode)}
            >
              {mode === 'recent' ? 'Most recent' : mode === 'votes' ? 'Most voted' : 'Most viewed'}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : debates.length === 0 ? (
        <div className={styles.emptyState}>
          <h2 className={styles.emptyTitle}>No public debates yet — pick one to start</h2>
          <p className={styles.emptySubtitle}>
            Click any topic below to open it on the arena. We&apos;ll fill in the question for you.
          </p>
          <div className={styles.exampleGrid}>
            {EXAMPLE_TOPICS.map(topic => (
              <Link
                key={topic}
                href={`/arena/debate?topic=${encodeURIComponent(topic)}`}
                className={styles.exampleCard}
              >
                <span className={styles.exampleTopic}>{topic}</span>
                <span className={styles.exampleArrow}>→</span>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.grid}>
          {debates.map(d => {
            const displayNames = getDisplayNames(d.models);
            return (
              <Link key={d.id} href={`/arena/debate/${d.id}`} className={styles.card}>
                <h2 className={styles.cardTopic}>{d.topic}</h2>

                <div className={styles.cardDebaters}>
                  {d.models.map((modelId, i) => {
                    const colour = getModelColour(modelId);
                    const position = d.positions[String(i)] || '';
                    return (
                      <div
                        key={i}
                        className={styles.cardDebater}
                        style={{ '--debater-colour': colour } as React.CSSProperties}
                      >
                        <span className={styles.cardDebaterName} style={{ color: colour }}>
                          {displayNames[i]}
                        </span>
                        {position && (
                          <span className={styles.cardDebaterPosition}>{position}</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {d.preview && (
                  <p className={styles.cardPreview}>“{d.preview}”</p>
                )}

                <div className={styles.cardMeta}>
                  <span>{d.argumentCount} {d.argumentCount === 1 ? 'argument' : 'arguments'}</span>
                  {config.showSocialMetrics && (
                    <>
                      <span>·</span>
                      <span>{d.voteCount} {d.voteCount === 1 ? 'vote' : 'votes'}</span>
                      <span>·</span>
                      <span>{d.viewCount} {d.viewCount === 1 ? 'view' : 'views'}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>{formatRelativeTime(d.createdAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
