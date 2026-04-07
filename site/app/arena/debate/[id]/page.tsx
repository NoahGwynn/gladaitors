// ============================================================================
// Shared Debate View — /arena/debate/[id]
// ============================================================================
// Public read-only view of a saved debate. Extends TTL on view.
// ============================================================================

'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import Link from 'next/link';
import { loadDebate } from '@/lib/debates';
import type { Debate } from '@/lib/types';
import styles from '../page.module.scss';

const MODEL_COLOURS: Record<string, string> = {
  claude: '#7C3AED',
  gpt4o: '#10B981',
  gemini: '#3B82F6',
};

const MODEL_NAMES: Record<string, string> = {
  claude: 'Claude',
  gpt4o: 'GPT-4o',
  gemini: 'Gemini',
};

export default function SharedDebatePage() {
  const params = useParams();
  const id = params.id as string;
  const [debate, setDebate] = useState<Debate | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    loadDebate(id).then(d => {
      if (d) {
        setDebate(d);
      } else {
        setNotFound(true);
      }
      setLoading(false);
    });
  }, [id]);

  if (loading) {
    return (
      <div className={styles.debatePanel}>
        <div className={styles.debateEmpty}>
          <img src="/brand/icon.png" alt="" className={styles.emptyIcon} />
          <p className={styles.emptyText}>Loading debate...</p>
        </div>
      </div>
    );
  }

  if (notFound || !debate) {
    return (
      <div className={styles.debatePanel}>
        <div className={styles.debateEmpty}>
          <img src="/brand/icon.png" alt="" className={styles.emptyIcon} />
          <p className={styles.emptyText}>
            Debate not found. It may have expired or been deleted.
          </p>
          <Link href="/arena/debate" className={styles.submitButton} style={{ textDecoration: 'none' }}>
            Create Your Own
          </Link>
        </div>
      </div>
    );
  }

  const positions = debate.positions as Record<string, string>;
  const args = debate.arguments as Array<{
    model_id: string;
    model_name: string;
    round: number;
    content: string;
    refused: boolean;
    refusal_reason?: string;
  }>;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40, textAlign: 'center' }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>{debate.topic}</h1>
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
          {debate.models.map(modelId => (
            <span key={modelId} style={{
              fontSize: 13,
              color: MODEL_COLOURS[modelId] || '#888',
              fontWeight: 600,
            }}>
              {MODEL_NAMES[modelId] || modelId}: {positions[modelId]}
            </span>
          ))}
        </div>
        <p style={{ fontSize: 13, color: '#4A4A6A', marginTop: 8 }}>
          {debate.rounds} rounds
        </p>
      </div>

      {/* Debate thread */}
      <div className={styles.debateThread}>
        {Array.from(new Set(args.map(a => a.round))).map(roundNum => (
          <div key={roundNum}>
            <div className={styles.roundDivider}>
              <span className={styles.roundLabel}>
                {roundNum === 1 ? 'Opening Statements' :
                 roundNum === debate.rounds ? 'Closing Statements' :
                 `Round ${roundNum}`}
              </span>
            </div>
            {args.filter(a => a.round === roundNum).map((arg, i) => (
              <div
                key={`${roundNum}-${arg.model_id}-${i}`}
                className={styles.argument}
                style={{ '--model-colour': MODEL_COLOURS[arg.model_id] || '#888' } as React.CSSProperties}
              >
                <div className={styles.argumentHeader}>
                  <span className={styles.argumentModel}>{arg.model_name}</span>
                  <span className={styles.argumentPosition}>{positions[arg.model_id]}</span>
                </div>
                {arg.refused ? (
                  <p className={styles.refusal}>
                    Declined this position{arg.refusal_reason ? `: ${arg.refusal_reason}` : ''}
                  </p>
                ) : (
                  <div className={styles.argumentContent}>
                    <ReactMarkdown>{arg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className={styles.postDebate} style={{ marginTop: 40 }}>
        <span className={styles.postDebateText}>
          Want to run your own debate?
        </span>
        <Link href="/arena/debate" className={styles.submitButton} style={{ textDecoration: 'none' }}>
          Create a Debate
        </Link>
      </div>
    </div>
  );
}
