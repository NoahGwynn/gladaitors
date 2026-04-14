// ============================================================================
// ForumSessionPage — top-level client component for a session page
// ============================================================================
// Subscribes to a forum_sessions row via Supabase Realtime and renders
// the session. Layout:
//
//   Title + date
//   Intro block (framing: transparent process, debate below, process above)
//   JourneyScrubber (6-stage hero element)
//   [Selected step's detail panel, if any]
//   DebateStream (when available — showing live during debate_in_progress,
//                 static when completed)
//
// The scrubber is the editorial navigation for the page. The debate is
// the default content below. Users can click any stage on the scrubber
// to see exactly what happened (or will happen) at that step.
//
// Before a session exists, the page shows the ScheduledState (countdown
// + overview). After the session has any data, the unified layout above
// takes over — the scrubber fills in as stages complete, and the debate
// section appears when stage 6 starts.
// ============================================================================

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRealtimeSession } from '@/lib/forum/useRealtimeSession';
import type { SessionRowForJourney } from '@/lib/forum/journey';
import {
  currentScrubberStage,
  completedScrubberStages,
} from '@/lib/forum/scrubber-stages';
import ScheduledState from './ScheduledState';
import JourneyScrubber from './JourneyScrubber';
import JourneyStepDetail from './JourneyStepDetail';
import DebateStream from './DebateStream';
import styles from './page.module.scss';

interface ForumSessionPageProps {
  category: string;
  sessionDate: string;
}

// Extra fields on the row that aren't in SessionRowForJourney
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

  // Step detail panel state:
  //   selectedStage — which stage's detail is currently open (null = none)
  //   userOverride — once the user clicks anything on the scrubber, we
  //                  stop auto-following the active stage and respect
  //                  whatever they chose (including "closed")
  const [selectedStage, setSelectedStage] = useState<number | null>(null);
  const [userOverride, setUserOverride] = useState(false);

  // Derive the active (pulsing) stage from the session status. This is
  // what the scrubber highlights as in-progress, and what we auto-expand
  // as long as the user hasn't taken over.
  const currentStage = currentScrubberStage(session?.status);
  const completedCount = completedScrubberStages(session?.status);
  // A stage is "actively in progress" if the current stage number is
  // greater than the completed count — i.e. work is happening there now.
  const activeStage = currentStage > completedCount ? currentStage : null;

  // Auto-expand the active stage when not overridden. This fires on
  // every session update, so as the pipeline advances through stages
  // the expanded detail follows along automatically.
  useEffect(() => {
    if (userOverride) return;
    setSelectedStage(activeStage);
  }, [activeStage, userOverride]);

  // Scrubber click handler — once the user clicks anything, we flip
  // to manual mode and stop following the active stage.
  function handleSelectStage(stage: number | null) {
    setUserOverride(true);
    setSelectedStage(stage);
  }

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

      {!loading && !error && renderContent(session, category, journey, selectedStage, handleSelectStage)}
    </div>
  );
}

function renderContent(
  session: SessionRowForJourney | null,
  category: string,
  journey: ReturnType<typeof useRealtimeSession>['journey'],
  selectedStage: number | null,
  setSelectedStage: (s: number | null) => void,
) {
  // No session or pre-pipeline → show the countdown + overview
  if (!session || session.status === 'scheduled') {
    return <ScheduledState category={category} />;
  }

  const status = session.status;
  const currentStage = currentScrubberStage(status);
  const completedCount = completedScrubberStages(status);

  // Failed state: still render the scrubber showing what completed,
  // and an inline error
  if (status === 'failed') {
    return (
      <>
        <IntroBlock />
        <JourneyScrubber
          currentStage={currentStage}
          completedCount={completedCount}
          selectedStage={selectedStage}
          onSelect={setSelectedStage}
        />
        {selectedStage !== null && (
          <JourneyStepDetail
            stageNumber={selectedStage}
            events={journey}
            onClose={() => setSelectedStage(null)}
          />
        )}
        <div className={styles.errorBox} style={{ marginTop: 24 }}>
          This session stopped before completing. {session.error}
        </div>
      </>
    );
  }

  // All other states: intro + scrubber + (maybe) step detail + (maybe) debate
  const debateSnapshot = session.debate_snapshot;
  const hasDebateData = debateSnapshot != null && debateSnapshot.turns.length > 0;
  const debateLive = status === 'debate_in_progress';

  return (
    <>
      <IntroBlock />
      <JourneyScrubber
        currentStage={currentStage}
        completedCount={completedCount}
        selectedStage={selectedStage}
        onSelect={setSelectedStage}
      />
      {selectedStage !== null && (
        <JourneyStepDetail
          stageNumber={selectedStage}
          events={journey}
          onClose={() => setSelectedStage(null)}
        />
      )}
      {hasDebateData && renderDebate(session, debateLive)}
      {!hasDebateData && (
        <div className={styles.prepStatus} style={{ marginTop: 24 }}>
          <span className={styles.prepStatusDot} />
          <span>
            {status === 'debate_in_progress'
              ? 'Debate kicking off — first turn landing shortly…'
              : 'Pipeline running — the discussion will appear here when the debate starts.'}
          </span>
        </div>
      )}
    </>
  );
}

function renderDebate(session: SessionRowForJourney, live: boolean) {
  const castSnapshot = (session as SessionRowForJourney & SessionRowExtra).cast_snapshot;
  const participants = castSnapshot?.participants || [];

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

// --- Intro block (the philosophical framing above the scrubber) ---

function IntroBlock() {
  return (
    <div className={styles.intro}>
      <p className={styles.introText}>
        <strong>
          Every part of today&apos;s session — topic, cast, agenda, and debate — is the
          result of a transparent, step-by-step process.
        </strong>{' '}
        The discussion is below. The process is above. Click any step to see how
        today&apos;s session was built.
      </p>
    </div>
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
