// ============================================================================
// SharedDebateView — client-side render for /arena/debate/[id]
// ============================================================================

'use client';

import ReactMarkdown from 'react-markdown';
import Link from 'next/link';
import ShareMenu from '@/components/ShareMenu';
import VotingPanel, { type VoteOption } from '@/components/VotingPanel';
import { findModel, getModelColour, getModelName } from '@/lib/models';
import type { Debate } from '@/lib/types';
import styles from '../page.module.scss';

/** Generate unique display names — adds numbering when the same model appears twice.
 *  User slots use "Human" as the base label.
 */
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

export default function SharedDebateView({ debate }: { debate: Debate | null }) {
  if (!debate) {
    return (
      <div className={styles.debatePanel} style={{ minHeight: 'calc(100vh - 64px)' }}>
        <div className={styles.debateEmpty}>
          <img src="/brand/icon.png" alt="" className={styles.emptyIcon} />
          <h2 className={styles.notFoundTitle}>Debate not found</h2>
          <p className={styles.emptyText}>
            This debate may have expired or been deleted.
          </p>
          <Link href="/arena/debate" className={styles.submitButton} style={{ textDecoration: 'none' }}>
            Create Your Own
          </Link>
        </div>
      </div>
    );
  }

  const positions = debate.positions as Record<string, string>;
  const displayNames = getDisplayNames(debate.models);

  const getPosition = (index: number) => positions[String(index)] || '';

  const args = debate.arguments as Array<{
    debater_index: number;
    model_id: string;
    model_name: string;
    round: number;
    content: string;
    refused: boolean;
    refusal_reason?: string;
  }>;

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/arena/debate/${debate.id}`
    : '';
  const maxRound = args.length > 0 ? Math.max(...args.map(a => a.round)) : 0;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px' }}>
      {/* Header */}
      <div className={styles.debateHeader}>
        {shareUrl && (
          <div className={styles.headerShareIcon}>
            <ShareMenu
              url={shareUrl}
              title={`AI Debate: ${debate.topic}`}
              text={`Watch ${displayNames.join(' vs ')} debate: "${debate.topic}"`}
              variant="icon"
            />
          </div>
        )}
        <h1 className={styles.debateTitle}>{debate.topic}</h1>
        <div className={styles.debatePositions}>
          {debate.models.map((modelId, i) => {
            const version = findModel(modelId)?.version;
            return (
              <span
                key={i}
                className={styles.debatePosition}
                style={{ color: getModelColour(modelId) }}
              >
                {displayNames[i]}
                {version && <span className={styles.debaterVersion}> {version}</span>}
                : {getPosition(i)}
              </span>
            );
          })}
        </div>
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
            {args.filter(a => a.round === roundNum).map((arg, i) => {
              if (arg.model_id === 'moderator') {
                return (
                  <div
                    key={`${roundNum}-mod-${i}`}
                    className={styles.moderatorNote}
                  >
                    <span className={styles.moderatorLabel}>Moderator note</span>
                    <p className={styles.moderatorText}>{arg.content}</p>
                  </div>
                );
              }
              return (
                <div
                  key={`${roundNum}-${arg.debater_index}-${i}`}
                  className={styles.argument}
                  style={{ '--model-colour': getModelColour(arg.model_id) } as React.CSSProperties}
                >
                  <div className={styles.argumentHeader}>
                    <span className={styles.argumentModel}>{arg.model_name}</span>
                    <span className={styles.argumentPosition}>
                      {getPosition(arg.debater_index)}
                    </span>
                    {arg.refused && <span className={styles.notChargedBadge}>Not charged</span>}
                  </div>
                  {arg.refused && arg.refusal_reason?.startsWith('API error:') ? (
                    <p className={styles.modelError}>
                      This model failed to respond.
                    </p>
                  ) : arg.refused ? (
                    <p className={styles.refusal}>
                      Declined this position{arg.refusal_reason ? `: ${arg.refusal_reason}` : ''}
                    </p>
                  ) : (
                    <div className={styles.argumentContent}>
                      <ReactMarkdown>{arg.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Voting */}
      {!args.every(a => a.refused) && (
        <div style={{ marginTop: 40, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
          <VotingPanel
            contentId={debate.id}
            contentType="debate"
            options={debate.models.map((modelId, i): VoteOption => ({
              id: String(i),
              name: `${displayNames[i]} — ${getPosition(i)}`,
              colour: getModelColour(modelId),
            }))}
          />
        </div>
      )}

      {/* Footer */}
      <div className={styles.postDebate} style={{ marginTop: 40 }}>
        <span className={styles.postDebateText}>
          {args.every(a => a.refused)
            ? 'All models declined their positions in this debate.'
            : `${maxRound} rounds · ${args.length} arguments`}
        </span>
        <Link href="/arena/debate" className={styles.submitButton} style={{ textDecoration: 'none', textAlign: 'center' }}>
          Create Your Own Debate
        </Link>
      </div>
    </div>
  );
}
