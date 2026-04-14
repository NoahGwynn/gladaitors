// ============================================================================
// ForumSessionPage — top-level client component for a session page
// ============================================================================
// Subscribes to a forum_sessions row via Supabase Realtime and renders
// the appropriate state based on the session's status:
//
//   - no session yet          → ScheduledState (countdown + overview)
//   - status=scheduled        → ScheduledState
//   - status=in_progress..agenda_built → Prep (journey timeline + detail cards)
//   - status=debate_in_progress → DebateStream (live, takes over)
//   - status=completed        → DebateStream (static) + JourneyTimeline below
//   - status=failed           → error view
//
// The session state drives everything — each child component reads from
// the same live session row. When a stage writes a new snapshot, the
// row updates, Realtime pushes it, the page re-renders.
// ============================================================================

'use client';

import Link from 'next/link';
import { useRealtimeSession } from '@/lib/forum/useRealtimeSession';
import type { SessionRowForJourney } from '@/lib/forum/journey';
import ScheduledState from './ScheduledState';
import JourneyTimeline from './JourneyTimeline';
import DebateStream from './DebateStream';
import styles from './page.module.scss';

interface ForumSessionPageProps {
  category: string;
  sessionDate: string;
}

// These fields live on the session row but aren't in SessionRowForJourney
// because the journey module doesn't need them. We read them here for
// the debate view.
interface SessionRowExtra {
  cast_snapshot?: {
    participants?: Array<{
      seat: number;
      modelName: string;
      provider: string;
    }>;
  } | null;
}

export default function ForumSessionPage({ category, sessionDate }: ForumSessionPageProps) {
  const { session, loading, error, journey } = useRealtimeSession(category, sessionDate);

  return (
    <div className={styles.page}>
      <Link href="/forum" className={styles.backLink}>
        ← Forum
      </Link>

      <div className={styles.heading}>
        <h1 className={styles.title}>
          d<span className={styles.titleAi}>AI</span>ly AI
        </h1>
        <div className={styles.sessionDate}>{formatHumanDate(sessionDate)}</div>
      </div>

      {loading && <div className={styles.loading}>Loading session…</div>}

      {error && (
        <div className={styles.errorBox}>
          Failed to load session: {error}
        </div>
      )}

      {!loading && !error && renderContent(session, category, journey)}
    </div>
  );
}

function renderContent(
  session: SessionRowForJourney | null,
  category: string,
  journey: ReturnType<typeof useRealtimeSession>['journey'],
) {
  // No session yet → pre-pipeline countdown
  if (!session) {
    return <ScheduledState category={category} />;
  }

  const status = session.status;

  // Scheduled or in_progress before anything interesting has happened
  if (status === 'scheduled') {
    return <ScheduledState category={category} />;
  }

  // Failed state
  if (status === 'failed') {
    return (
      <>
        <div className={styles.errorBox}>
          This session encountered a failure and stopped.{' '}
          {session.error && <span>{session.error}</span>}
        </div>
        {journey.length > 0 && <JourneyTimeline events={journey} />}
      </>
    );
  }

  // Debate in progress — takes over the viewport (journey collapses)
  if (status === 'debate_in_progress' && session.debate_snapshot) {
    return renderDebate(session, /* live */ true);
  }

  // Completed — full permanent record, both debate and journey visible
  if (status === 'completed' && session.debate_snapshot) {
    return (
      <>
        {renderDebate(session, /* live */ false)}
        <div style={{ marginTop: 48 }}>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text-primary)',
              marginBottom: 16,
            }}
          >
            How we got here
          </h2>
          <JourneyTimeline events={journey} />
        </div>
      </>
    );
  }

  // All prep-phase states: show the journey timeline with the current
  // stage marked as in_progress
  return (
    <div className={styles.prepWrap}>
      <div className={styles.prepStatus}>
        <span className={styles.prepStatusDot} />
        <span>Pipeline running — stage {currentStageNumber(status)} of 6</span>
      </div>
      <JourneyTimeline events={journey} inProgress />
    </div>
  );
}

function renderDebate(session: SessionRowForJourney, live: boolean) {
  // Extract cast from the cast snapshot — we need seat/provider/modelName
  // for the debate stream component
  const castSnapshot = (session as SessionRowForJourney & SessionRowExtra).cast_snapshot;
  const participants = castSnapshot?.participants || [];

  // Topic title — fall back to whatever is available
  const organizeSnapshot = session.organize_snapshot;
  let topicTitle = '(unknown topic)';
  if (organizeSnapshot && session.selected_thread_id) {
    const entry = organizeSnapshot.mergedShortlist?.find(
      (t) => t.threadId === session.selected_thread_id,
    );
    if (entry) topicTitle = entry.threadTitle;
  }

  return (
    <DebateStream
      snapshot={session.debate_snapshot!}
      sessionType={session.session_type || null}
      topicTitle={topicTitle}
      cast={participants}
      live={live}
    />
  );
}

// --- Helpers ---

function formatHumanDate(isoDate: string): string {
  try {
    const d = new Date(isoDate + 'T00:00:00');
    return d.toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

function currentStageNumber(status: string): number {
  const stageByStatus: Record<string, number> = {
    in_progress: 2,
    topic_selected: 3,
    moderator_selected: 4,
    researched: 5,
    cast_selected: 5,
    deep_researched: 5,
    agenda_built: 5,
    debate_in_progress: 6,
  };
  return stageByStatus[status] || 2;
}
