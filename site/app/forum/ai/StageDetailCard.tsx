// ============================================================================
// StageDetailCard — per-stage drill-down rendering
// ============================================================================
// Given a JourneyEvent, render the stage-specific detail. Each event
// step has its own sub-renderer for the things worth highlighting.
//
// The event.data shape is defined by the builders in lib/forum/journey.ts.
// We type-assert lightly rather than sharing types across the boundary
// because the data is inspection-only for the UI.
// ============================================================================

'use client';

import type { JourneyEvent } from '@/lib/forum/journey';
import { getProviderColor } from '@/lib/forum/session-colors';
import styles from './page.module.scss';

interface StageDetailCardProps {
  event: JourneyEvent;
}

export default function StageDetailCard({ event }: StageDetailCardProps) {
  const data = event.data as Record<string, unknown>;

  switch (event.step) {
    case 'organizers_complete':
      return <OrganizersDetail data={data} />;
    case 'pool_responded':
      return <PoolResponseDetail data={data} />;
    case 'votes_scored':
      return <VotesScoredDetail data={data} />;
    case 'tie_detected':
      return <TieDetectedDetail data={data} />;
    case 'runoff_complete':
      return <RunoffCompleteDetail data={data} />;
    case 'acting_moderator_chosen':
      return <ActingModeratorDetail data={data} />;
    case 'moderator_selected':
      return <ModeratorSelectedDetail data={data} />;
    case 'research_complete':
      return <ResearchDetail data={data} />;
    case 'cast_assembled':
      return <CastAssembledDetail data={data} />;
    case 'also_invited':
      return <AlsoInvitedDetail data={data} />;
    case 'deep_research_complete':
      return <DeepResearchDetail data={data} />;
    case 'agenda_built':
      return <AgendaDetail data={data} />;
    case 'debate_complete':
      return <DebateCompleteDetail data={data} />;
    default:
      return null;
  }
}

// --- Typed helpers for lighter inline handling ---

interface ShortlistEntry {
  threadId: string;
  title: string;
  averageRank: number;
  organizerAgreement: number;
  includedBy: string[];
  isRevisit: boolean;
}

function OrganizersDetail({ data }: { data: Record<string, unknown> }) {
  const shortlist = (data.mergedShortlist || []) as ShortlistEntry[];
  return (
    <div>
      <Stats
        stats={[
          ['Threads evaluated', data.threadsEvaluated],
          ['Active threads', data.activeThreadCount],
          ['Revisit candidates', data.revisitThreadCount],
          ['Organizer A shortlist', data.organizerAShortlist],
          ['Organizer B shortlist', data.organizerBShortlist],
          ['Both agreed', data.agreedCount],
          ['Divergences', data.divergedCount],
        ]}
      />
      {shortlist.length > 0 && (
        <>
          <div className={styles.detailSection}>Merged shortlist</div>
          <ul className={styles.detailList}>
            {shortlist.map((t) => (
              <li key={t.threadId} className={styles.detailListItem}>
                {t.title}
                {t.organizerAgreement === 2 ? ' (both organizers)' : ` (only ${t.includedBy.join(', ')})`}
                {t.isRevisit ? ' — revisit' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface PerModel {
  modelName: string;
  provider: string;
  voteCount: number;
  conflictCount: number;
  stanceCount: number;
  error?: string;
}

function PoolResponseDetail({ data }: { data: Record<string, unknown> }) {
  const perModel = (data.perModel || []) as PerModel[];
  const skipped = (data.skippedModels || []) as Array<{ name: string; reason: string }>;
  return (
    <div>
      <Stats
        stats={[
          ['Responded', data.respondedCount],
          ['Failed', data.failedCount],
          ['Skipped (no key)', data.skippedCount],
        ]}
      />
      {perModel.length > 0 && (
        <>
          <div className={styles.detailSection}>Pool responses</div>
          <ul className={styles.detailList}>
            {perModel.map((m) => (
              <li key={m.modelName} className={styles.detailListItem}>
                <span style={{ color: getProviderColor(m.provider) }}>{m.modelName}</span> —{' '}
                {m.error ? `failed: ${m.error}` : `${m.voteCount} votes, ${m.conflictCount} conflicts, ${m.stanceCount} stances`}
              </li>
            ))}
          </ul>
        </>
      )}
      {skipped.length > 0 && (
        <>
          <div className={styles.detailSection}>Skipped</div>
          <ul className={styles.detailList}>
            {skipped.map((s) => (
              <li key={s.name} className={styles.detailListItem}>
                {s.name} — {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface VoteScore {
  title: string | null;
  threadId: string;
  score: number;
  voterCount: number;
}

function VotesScoredDetail({ data }: { data: Record<string, unknown> }) {
  const scores = ((data.scores as VoteScore[]) || []).slice(0, 10);
  return (
    <div>
      <Stats
        stats={[
          ['Margin to 2nd', data.marginToSecondPct != null ? `${(data.marginToSecondPct as number).toFixed(1)}%` : 'n/a'],
        ]}
      />
      <div className={styles.detailSection}>Scores (top 10)</div>
      <ul className={styles.detailList}>
        {scores.map((s) => (
          <li key={s.threadId} className={styles.detailListItem}>
            <strong>{s.score} pts</strong> — {s.title || s.threadId.slice(0, 8)} ({s.voterCount} voter{s.voterCount === 1 ? '' : 's'})
          </li>
        ))}
      </ul>
    </div>
  );
}

function TieDetectedDetail({ data }: { data: Record<string, unknown> }) {
  const titles = (data.tiedTitles as string[]) || [];
  return (
    <div>
      <div className={styles.detailSection}>Tied topics</div>
      <ul className={styles.detailList}>
        {titles.map((t, i) => (
          <li key={i} className={styles.detailListItem}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RunoffPick {
  modelName: string;
  pick: string | null;
  urgency: Record<string, number>;
}

function RunoffCompleteDetail({ data }: { data: Record<string, unknown> }) {
  const picks = (data.picks as RunoffPick[]) || [];
  const urgencyTotals = (data.urgencyTotals || {}) as Record<string, number>;
  const pickCounts = (data.pickCounts || {}) as Record<string, number>;
  return (
    <div>
      <Stats
        stats={[
          ['Resolved by', String(data.resolvedBy || 'unknown')],
          ['Urgency margin', data.urgencyMarginPct != null ? `${(data.urgencyMarginPct as number).toFixed(1)}%` : 'n/a'],
        ]}
      />
      <div className={styles.detailSection}>Urgency totals</div>
      <ul className={styles.detailList}>
        {Object.entries(urgencyTotals).map(([id, total]) => (
          <li key={id} className={styles.detailListItem}>
            {id.slice(0, 8)} — <strong>{total}</strong>
          </li>
        ))}
      </ul>
      <div className={styles.detailSection}>Pick counts</div>
      <ul className={styles.detailList}>
        {Object.entries(pickCounts).map(([id, count]) => (
          <li key={id} className={styles.detailListItem}>
            {id.slice(0, 8)} — <strong>{count}</strong>
          </li>
        ))}
      </ul>
      {picks.length > 0 && (
        <>
          <div className={styles.detailSection}>Per-model picks</div>
          <ul className={styles.detailList}>
            {picks.map((p, i) => (
              <li key={i} className={styles.detailListItem}>
                {p.modelName}: {p.pick?.slice(0, 8) || 'none'}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ActingModeratorDetail({ data }: { data: Record<string, unknown> }) {
  const conflicts = (data.conflicts || {}) as Record<string, number>;
  return (
    <div>
      <Stats
        stats={[
          ['Model', String(data.modelId || '?')],
          ['Tier', data.tier as number],
        ]}
      />
      <div className={styles.detailSection}>Their conflict scores on tied topics</div>
      <ul className={styles.detailList}>
        {Object.entries(conflicts).map(([id, score]) => (
          <li key={id} className={styles.detailListItem}>
            {id.slice(0, 8)}: {score}
          </li>
        ))}
      </ul>
      {data.reasoning != null && (
        <>
          <div className={styles.detailSection}>Reasoning</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{String(data.reasoning)}</p>
        </>
      )}
    </div>
  );
}

interface SkippedModerator {
  modelName: string;
  conflictScore: number;
  reason: string;
}

function ModeratorSelectedDetail({ data }: { data: Record<string, unknown> }) {
  const skipped = (data.skipped || []) as SkippedModerator[];
  return (
    <div>
      <Stats
        stats={[
          ['Model', String(data.modelId || '?')],
          ['Tier', data.tier === null ? 'fallback' : String(data.tier)],
          ['Conflict score', `${data.conflictScore}/100`],
          ['Method', String(data.method || '?')],
          ['Region softcap applied', data.regionSoftcapApplied ? 'yes' : 'no'],
        ]}
      />
      {skipped.length > 0 && (
        <>
          <div className={styles.detailSection}>Models walked over</div>
          <ul className={styles.detailList}>
            {skipped.map((s, i) => (
              <li key={i} className={styles.detailListItem}>
                {s.modelName} (conflict {s.conflictScore}) — {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ResearchDetail({ data }: { data: Record<string, unknown> }) {
  const facts = (data.synthesisedFacts || []) as string[];
  const contested = (data.contestedClaims || []) as string[];
  const open = (data.openQuestions || []) as string[];
  return (
    <div>
      {data.overallSummary != null && (
        <>
          <div className={styles.detailSection}>Overall summary</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{String(data.overallSummary)}</p>
        </>
      )}
      {facts.length > 0 && (
        <>
          <div className={styles.detailSection}>Synthesised facts</div>
          <ul className={styles.detailList}>
            {facts.map((f, i) => (
              <li key={i} className={styles.detailListItem}>
                {f}
              </li>
            ))}
          </ul>
        </>
      )}
      {contested.length > 0 && (
        <>
          <div className={styles.detailSection}>Contested claims</div>
          <ul className={styles.detailList}>
            {contested.map((c, i) => (
              <li key={i} className={styles.detailListItem}>
                {c}
              </li>
            ))}
          </ul>
        </>
      )}
      {open.length > 0 && (
        <>
          <div className={styles.detailSection}>Open questions</div>
          <ul className={styles.detailList}>
            {open.map((q, i) => (
              <li key={i} className={styles.detailListItem}>
                {q}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface CastParticipantDetail {
  modelName: string;
  provider: string;
  seat: number;
  stance: string;
  conflictScore: number;
  reasoning: string;
}

function CastAssembledDetail({ data }: { data: Record<string, unknown> }) {
  const participants = (data.participants || []) as CastParticipantDetail[];
  return (
    <div>
      <Stats
        stats={[
          ['Session type', String(data.sessionType || '?')],
          ['Seats', participants.length],
        ]}
      />
      {data.moderatorReasoning != null && (
        <>
          <div className={styles.detailSection}>Moderator&apos;s overall reasoning</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            {String(data.moderatorReasoning)}
          </p>
        </>
      )}
      <div className={styles.detailSection}>Cast picks</div>
      {participants.map((p) => (
        <div key={p.seat} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, color: getProviderColor(p.provider), marginBottom: 4 }}>
            Seat {p.seat}: {p.modelName}{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
              (conflict {p.conflictScore})
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
            <strong>Stance:</strong> {p.stance}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {p.reasoning}
          </div>
        </div>
      ))}
    </div>
  );
}

interface AlsoInvitedEntry {
  modelName: string;
  provider: string;
  stance: string;
  conflictScore: number;
  voteRank: number | null;
}

function AlsoInvitedDetail({ data }: { data: Record<string, unknown> }) {
  const also = (data.alsoInvited || []) as AlsoInvitedEntry[];
  if (also.length === 0) return null;
  return (
    <div>
      {also.map((a) => (
        <div key={a.modelName} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, color: getProviderColor(a.provider), fontSize: 13 }}>
            {a.modelName}{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
              (conflict {a.conflictScore}
              {a.voteRank != null ? `, vote rank ${a.voteRank}` : ''})
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {a.stance}
          </div>
        </div>
      ))}
    </div>
  );
}

interface KeyClaim {
  claim: string;
  citations: Array<{ type: 'db' | 'web'; ref: string }>;
}

interface WebSearch {
  query: string;
  reason: string;
  results: Array<{ url: string; title: string; score: number }>;
  error: string | null;
}

function DeepResearchDetail({ data }: { data: Record<string, unknown> }) {
  const claims = ((data.keyClaims || []) as KeyClaim[]).slice(0, 10);
  const webSearches = (data.webSearches || []) as WebSearch[];
  const gaps = (data.gapsInCoverage || []) as string[];
  return (
    <div>
      <Stats
        stats={[
          ['DB sources fetched', `${data.dbSourceCount}/${data.dbSourceTotal}`],
          ['Web queries run', `${data.webQueriesRun}/${data.webQueriesRequested}`],
          ['Web results', data.webResultsTotal],
          ['Cap hit', data.capHit ? 'yes' : 'no'],
        ]}
      />
      {data.overallSynthesis != null && (
        <>
          <div className={styles.detailSection}>Synthesis</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {String(data.overallSynthesis)}
          </p>
        </>
      )}
      {claims.length > 0 && (
        <>
          <div className={styles.detailSection}>Key claims (top 10)</div>
          <ul className={styles.detailList}>
            {claims.map((c, i) => (
              <li key={i} className={styles.detailListItem}>
                {c.claim}{' '}
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  [{c.citations.map((x) => x.type).join(', ')}]
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {webSearches.length > 0 && (
        <>
          <div className={styles.detailSection}>Web search queries</div>
          <ul className={styles.detailList}>
            {webSearches.map((ws, i) => (
              <li key={i} className={styles.detailListItem}>
                <strong>&ldquo;{ws.query}&rdquo;</strong> — {ws.reason} ({ws.results.length} results)
              </li>
            ))}
          </ul>
        </>
      )}
      {gaps.length > 0 && (
        <>
          <div className={styles.detailSection}>Remaining gaps</div>
          <ul className={styles.detailList}>
            {gaps.map((g, i) => (
              <li key={i} className={styles.detailListItem}>
                {g}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface AgendaSegmentSummary {
  name: string;
  mainQuestion: string;
  subQuestions: string[];
  participantsToAsk: number[];
  whyItMatters: string;
  expectedDuration: string;
  relatedResearchCount: number;
  relatedMemoryCount: number;
}

function AgendaDetail({ data }: { data: Record<string, unknown> }) {
  const segments = (data.segments || []) as AgendaSegmentSummary[];
  const optional = (data.optionalDeepening || []) as Array<{ name: string; mainQuestion: string }>;
  const goals = (data.goals || []) as string[];
  const tags = (data.topicTags || []) as string[];
  return (
    <div>
      <Stats
        stats={[
          ['Segments', segments.length],
          ['Optional deepening', optional.length],
          ['Topic tags', tags.join(', ') || 'none'],
        ]}
      />
      {data.sessionFraming != null && (
        <>
          <div className={styles.detailSection}>Session framing</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, fontStyle: 'italic' }}>
            {String(data.sessionFraming)}
          </p>
        </>
      )}
      {goals.length > 0 && (
        <>
          <div className={styles.detailSection}>Goals</div>
          <ul className={styles.detailList}>
            {goals.map((g, i) => (
              <li key={i} className={styles.detailListItem}>
                {g}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className={styles.detailSection}>Planned segments</div>
      {segments.map((s, i) => (
        <div key={i} style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
            {i + 1}. {s.name} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({s.expectedDuration})</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Q: {s.mainQuestion}
          </div>
          {s.whyItMatters && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
              {s.whyItMatters}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
            Ask seats: [{s.participantsToAsk.join(', ')}] · {s.relatedResearchCount} research refs ·{' '}
            {s.relatedMemoryCount} memory refs
          </div>
        </div>
      ))}
      {optional.length > 0 && (
        <>
          <div className={styles.detailSection}>Optional deepening</div>
          <ul className={styles.detailList}>
            {optional.map((o, i) => (
              <li key={i} className={styles.detailListItem}>
                <strong>{o.name}</strong> — {o.mainQuestion}
              </li>
            ))}
          </ul>
        </>
      )}
      {data.closingFrame != null && (
        <>
          <div className={styles.detailSection}>Closing frame</div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, fontStyle: 'italic' }}>
            {String(data.closingFrame)}
          </p>
        </>
      )}
    </div>
  );
}

function DebateCompleteDetail({ data }: { data: Record<string, unknown> }) {
  const moves = (data.moveCounts || {}) as Record<string, number>;
  const segs = (data.segmentProgress || []) as Array<{ segmentName: string; status: string; exchangesSpent: number }>;
  return (
    <div>
      <Stats
        stats={[
          ['Exchange turns', data.exchangeTurnCount],
          ['Total records', data.totalTurnRecords],
          ['Utterances stored', data.utterancesStored],
          ['Force close', data.forceCloseApplied ? 'yes' : 'no'],
        ]}
      />
      <div className={styles.detailSection}>Moves used</div>
      <ul className={styles.detailList}>
        {Object.entries(moves)
          .filter(([, n]) => n > 0)
          .map(([m, n]) => (
            <li key={m} className={styles.detailListItem}>
              {m} × {n}
            </li>
          ))}
      </ul>
      <div className={styles.detailSection}>Segment coverage</div>
      <ul className={styles.detailList}>
        {segs.map((s, i) => (
          <li key={i} className={styles.detailListItem}>
            <strong>[{s.status}]</strong> {s.segmentName} — {s.exchangesSpent} exchanges
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Shared stats row ---

function Stats({ stats }: { stats: Array<[string, unknown]> }) {
  return (
    <div>
      {stats
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([label, value]) => (
          <div key={label} className={styles.detailStat}>
            <span className={styles.detailStatLabel}>{label}</span>
            <span className={styles.detailStatValue}>{String(value)}</span>
          </div>
        ))}
    </div>
  );
}
