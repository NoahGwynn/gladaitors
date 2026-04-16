// ============================================================================
// SharedDebateView — client-side render for /journal/debate/[id]
// ============================================================================

'use client';

import ReactMarkdown from 'react-markdown';
import Link from 'next/link';
import { ChevronLeft, EyeOff } from 'lucide-react';
import ShareMenu from '@/components/ShareMenu';
import VotingPanel, { type VoteOption } from '@/components/VotingPanel';
import { findModel, getModelColour, getModelName } from '@/lib/models';
import { getTemplateBySlug } from '@/lib/debate-templates';
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
          <Link href="/journal/debate" className={styles.submitButton} style={{ textDecoration: 'none' }}>
            Create Your Own
          </Link>
        </div>
      </div>
    );
  }

  const positions = debate.positions as Record<string, string>;
  const displayNames = getDisplayNames(debate.models);
  const autoAssigned = debate.auto_assigned ?? null;
  const wasAnonymous = debate.reveal_identities === false;

  const getPosition = (index: number) => positions[String(index)] || '';
  const isAuto = (index: number) =>
    Array.isArray(autoAssigned) && autoAssigned[index] === true;

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
    ? `${window.location.origin}/journal/debate/${debate.id}`
    : '';
  const maxRound = args.length > 0 ? Math.max(...args.map(a => a.round)) : 0;

  return (
    <>
      {/* Top nav row holds the back link on the left and the share icon
          on the right — a balanced pair in their own wider container so
          they sit at the page-content edges, not floating above the
          centered debate body. */}
      <div className={styles.sharedTopNav}>
        <Link href="/explore" className={styles.sharedBackLink}>
          <ChevronLeft size={16} />
          <span>Explore</span>
        </Link>
        {shareUrl && (
          <ShareMenu
            url={shareUrl}
            title={`AI Debate: ${debate.topic}`}
            text={`Watch ${displayNames.join(' vs ')} debate: "${debate.topic}"`}
            variant="icon"
          />
        )}
      </div>

      <div className={styles.sharedContentWrapper}>
      {/* Header */}
      <div className={`${styles.debateHeader} ${styles.sharedDebateHeader}`}>
        <h1 className={styles.debateTitle}>{debate.topic}</h1>

        {/* Stacked debater list — name on its own line in brand colour
            (bold, same weight as the title-tier text), stance directly
            beneath in the same brand colour at lighter weight. Cleaner
            than the previous "× vs line + separate positions block"
            stack which read as noisy. */}
        <div className={styles.sharedDebatersList}>
          {debate.models.map((modelId, i) => {
            const colour = getModelColour(modelId);
            const version = findModel(modelId)?.version;
            return (
              <div key={i} className={styles.sharedDebaterEntry}>
                <div className={styles.sharedDebaterName} style={{ color: colour }}>
                  {displayNames[i]}
                  {version && <span className={styles.debaterVersion}> {version}</span>}
                </div>
                <div className={styles.sharedDebaterStance} style={{ color: colour }}>
                  {getPosition(i)}
                  {isAuto(i) && (
                    <span className={styles.sharedSelfChosen}> · chosen by the model</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Anonymous mode banner — runs only when reveal_identities is
            explicitly false. Legacy rows where the field is null skip
            the banner. */}
        {wasAnonymous && (
          <div className={styles.sharedAnonymousBanner}>
            <EyeOff size={14} />
            <span>Anonymous mode — the models didn&apos;t know who they were debating.</span>
          </div>
        )}
      </div>

      {/* Per-template disclaimer (e.g. hiring). Shown above the thread
          on the shared view too so anyone reading via a permalink sees
          the same framing the original creator did. */}
      {(() => {
        const template = getTemplateBySlug(debate.template_slug ?? null);
        if (!template?.disclaimer) return null;
        return (
          <div className={styles.templateDisclaimer} role="note">
            <strong>Heads up:</strong> {template.disclaimer}
          </div>
        );
      })()}

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

      {/* Footer — two routes out: convert (create your own) or
          discover more debates. Create stays the primary CTA because
          it's the conversion goal; Browse is the secondary text link. */}
      <div className={styles.postDebate} style={{ marginTop: 40 }}>
        <span className={styles.postDebateText}>
          {args.every(a => a.refused)
            ? 'All models declined their positions in this debate.'
            : `${maxRound} rounds · ${args.length} arguments`}
        </span>
        <Link href="/journal/debate" className={styles.submitButton} style={{ textDecoration: 'none', textAlign: 'center' }}>
          Create Your Own Debate
        </Link>
        <Link href="/explore" className={styles.sharedBrowseMoreLink}>
          or browse more debates →
        </Link>
      </div>
      </div>
    </>
  );
}
