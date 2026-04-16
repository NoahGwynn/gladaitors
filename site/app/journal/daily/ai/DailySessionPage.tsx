// ============================================================================
// DailySessionPage — top-level client component for a session page
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
import { useRealtimeSession } from '@/lib/daily/useRealtimeSession';
import type { SessionRowForJourney } from '@/lib/daily/journey';
import { MODEL_POOL } from '@/lib/daily/model-pool';
import {
  currentScrubberStage,
  completedScrubberStages,
} from '@/lib/daily/scrubber-stages';
import ScheduledState from './ScheduledState';
import JourneyScrubber from './JourneyScrubber';
import JourneyStepDetail from './JourneyStepDetail';
import DebateStream from './DebateStream';
import styles from './page.module.scss';

interface DailySessionPageProps {
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

export default function DailySessionPage({ category, sessionDate }: DailySessionPageProps) {
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
      <Link href="/journal/daily" className={styles.backLink}>
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

      {!loading && !error && renderContent(session, category, journey, selectedStage, handleSelectStage, activeStage)}
    </div>
  );
}

function renderContent(
  session: SessionRowForJourney | null,
  category: string,
  journey: ReturnType<typeof useRealtimeSession>['journey'],
  selectedStage: number | null,
  setSelectedStage: (s: number | null) => void,
  activeStage: number | null,
) {
  // No session or pre-pipeline → show the countdown + overview
  if (!session || session.status === 'scheduled') {
    return <ScheduledState category={category} />;
  }

  const status = session.status;
  const currentStage = currentScrubberStage(status);
  const completedCount = completedScrubberStages(status);

  // Is the currently-open detail panel showing the active (pulsing) stage?
  const showingActive = selectedStage !== null && selectedStage === activeStage;

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
            isActive={showingActive}
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
  const isHeldForModeration = status === 'held_for_moderation';

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
      {isHeldForModeration && renderHeldForModerationBanner(session)}
      {/* CRITICAL: never render the debate transcript when held for
          moderation. The screening pipeline raised a critical finding
          OR errored — either way we cannot publish content we have
          not screened cleanly. The held banner above explains what
          happened. The debate body is intentionally hidden until
          an operator clears the session.
          (Per the dAIly's rule: skipping a day is always acceptable.
          A skipped day is fine. A bad day is not.) */}
      {!isHeldForModeration && hasDebateData && renderDebate(session, debateLive)}
      {!isHeldForModeration && !hasDebateData && (
        <div className={styles.prepStatus} style={{ marginTop: 64 }}>
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

// Renders a banner explaining why a session is being held from public
// publication. Only shown to whoever is looking at the page during
// the held state — which is the operator during the pilot, and in
// future may be gated to admins only.
function renderHeldForModerationBanner(session: SessionRowForJourney) {
  const mod = session.moderation_snapshot;
  const reason = mod?.decisionReason || session.error || 'Critical finding raised by the moderation pipeline.';
  const critical = mod?.criticalCount ?? 0;
  const minor = mod?.minorCount ?? 0;

  // Collect the critical findings across all checks for display
  const criticalFindings = (mod?.checks || [])
    .flatMap((c) => c.findings || [])
    .filter((f) => f.severity === 'critical');

  return (
    <div className={styles.heldBanner}>
      <div className={styles.heldBannerLabel}>
        Held for operator review — not published
      </div>
      <p className={styles.heldBannerText}>
        This session was generated and ran through the shared moderation
        pipeline. {critical > 0 && (
          <>
            <strong>{critical} critical finding{critical === 1 ? '' : 's'}</strong>
            {minor > 0 ? ` (plus ${minor} minor)` : ''} {critical === 1 ? 'was' : 'were'} raised,
            so the session is held until the operator reviews it.
          </>
        )}{' '}
        {reason}
      </p>
      {criticalFindings.length > 0 && (
        <details className={styles.heldBannerFindings}>
          <summary>Show critical findings ({criticalFindings.length})</summary>
          <ul>
            {criticalFindings.map((f, i) => (
              <li key={i}>
                <div className={styles.heldFindingCheck}>{f.check} · {f.location}</div>
                <div className={styles.heldFindingIssue}>{f.issue}</div>
                <div className={styles.heldFindingRationale}>{f.rationale}</div>
                {f.suggestion && (
                  <div className={styles.heldFindingSuggestion}>
                    <strong>Suggestion:</strong> {f.suggestion}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className={styles.heldBannerFooter}>
        The dAIly&apos;s rule: skipping a day is always acceptable. A skipped day is fine. A bad day is not.
      </p>
    </div>
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

  // Moderated sessions resolve the chair's display info from MODEL_POOL.
  // Unmoderated sessions have no chair — the DebateStream component
  // renders without a moderator roster row when this is null.
  const moderatorId = session.moderator_model_id || session.acting_moderator_model_id;
  let moderator: { modelId: string; modelName: string; provider: string } | null = null;
  if (moderatorId) {
    const poolEntry = MODEL_POOL.find((m) => m.id === moderatorId);
    if (poolEntry) {
      moderator = {
        modelId: poolEntry.id,
        modelName: poolEntry.displayName,
        provider: poolEntry.provider,
      };
    } else {
      moderator = { modelId: moderatorId, modelName: moderatorId, provider: 'unknown' };
    }
  }

  const debateFormat: 'moderated' | 'unmoderated' =
    session.debate_format === 'unmoderated' ? 'unmoderated' : 'moderated';
  const unmoderatedReason = debateFormat === 'unmoderated'
    ? (session.debate_format_reason ?? null)
    : null;

  return (
    <DebateStream
      snapshot={session.debate_snapshot!}
      sessionType={session.session_type || null}
      topicTitle={topicTitle}
      moderator={moderator}
      cast={participants}
      live={live}
      debateFormat={debateFormat}
      unmoderatedReason={unmoderatedReason}
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
