// ============================================================================
// JourneyStepDetail — expanded panel for a selected scrubber stage
// ============================================================================
// When a user clicks a dot on the JourneyScrubber, this panel expands
// inline below showing all journey events that belong to that stage.
// Each event has a plain English title + description up front, and
// a "Show technical detail" toggle that reveals the existing
// StageDetailCard's data drill-down.
//
// If the stage hasn't happened yet, shows the explainer copy from
// scrubber-stages.ts so users can see what the stage will do.
// ============================================================================

'use client';

import { useState } from 'react';
import type { JourneyEvent } from '@/lib/forum/journey';
import { SCRUBBER_STAGES } from '@/lib/forum/scrubber-stages';
import StageDetailCard from './StageDetailCard';
import styles from './page.module.scss';

interface JourneyStepDetailProps {
  /** 1-based stage number the user clicked on the scrubber */
  stageNumber: number;
  /** All journey events currently available on the session */
  events: JourneyEvent[];
  /** Called when the user clicks the close button */
  onClose: () => void;
}

export default function JourneyStepDetail({
  stageNumber,
  events,
  onClose,
}: JourneyStepDetailProps) {
  const stage = SCRUBBER_STAGES.find((s) => s.num === stageNumber);
  if (!stage) return null;

  // Filter the events to just the ones belonging to this stage,
  // preserving the journey's natural order rather than the eventSteps
  // declaration order (the journey reflects what actually happened).
  const relevantEvents = events.filter((e) => stage.eventSteps.includes(e.step));

  return (
    <div className={styles.stepDetail}>
      <div className={styles.stepDetailHeader}>
        <div>
          <div className={styles.stepDetailStageNumber}>Stage {stage.num}</div>
          <h2 className={styles.stepDetailTitle}>{stage.fullTitle}</h2>
          <p className={styles.stepDetailExplainer}>{stage.explainer}</p>
        </div>
        <button
          type="button"
          className={styles.stepDetailClose}
          onClick={onClose}
          aria-label="Close detail panel"
        >
          ×
        </button>
      </div>

      {relevantEvents.length === 0 ? (
        <div className={styles.stepDetailEmpty}>
          This stage hasn&apos;t happened yet. Come back when the pipeline reaches it.
        </div>
      ) : (
        <div className={styles.stepDetailEvents}>
          {relevantEvents.map((event, i) => (
            <StepDetailEvent key={`${event.step}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Single event inside the panel ---

function StepDetailEvent({ event }: { event: JourneyEvent }) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const hasTechnicalDetail = hasDetail(event);
  const formattedTime = formatEventTime(event.timestamp);

  return (
    <div className={styles.stepDetailEvent}>
      <div className={styles.stepDetailEventHeader}>
        <h3 className={styles.stepDetailEventTitle}>{event.title}</h3>
        {formattedTime && (
          <time className={styles.stepDetailEventTime} dateTime={event.timestamp}>
            {formattedTime}
          </time>
        )}
      </div>
      <p className={styles.stepDetailEventDescription}>{event.description}</p>
      {hasTechnicalDetail && (
        <>
          <button
            type="button"
            className={styles.stepDetailEventTechnicalToggle}
            onClick={() => setTechnicalOpen((o) => !o)}
          >
            {technicalOpen ? '▾ Hide technical detail' : '▸ Show technical detail'}
          </button>
          {technicalOpen && (
            <div className={styles.stepDetailEventTechnical}>
              <StageDetailCard event={event} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Format an ISO timestamp for display next to a journey event.
 *  - Same day as today: "14:32:05"
 *  - Different day: "14 Apr · 14:32"
 *  Always uses the browser's local time — the audience sees when
 *  things happened in their own timezone. */
function formatEventTime(isoTimestamp: string | undefined): string | null {
  if (!isoTimestamp) return null;
  try {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) return null;

    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    if (sameDay) {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date);
    }

    const datePart = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
    }).format(date);
    const timePart = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
    return `${datePart} · ${timePart}`;
  } catch {
    return null;
  }
}

/** True if this event has drill-down data worth showing. */
function hasDetail(event: JourneyEvent): boolean {
  const withDetail = new Set([
    'organizers_complete',
    'pool_responded',
    'votes_scored',
    'tie_detected',
    'runoff_complete',
    'acting_moderator_chosen',
    'moderator_selected',
    'research_complete',
    'cast_assembled',
    'also_invited',
    'deep_research_complete',
    'agenda_built',
    'debate_complete',
  ]);
  return withDetail.has(event.step);
}
