// ============================================================================
// JourneyTimeline — scrolling list of pipeline stages
// ============================================================================
// Renders the derived journey events from the session row as a vertical
// timeline. Each event is a card with stage label, title, description,
// and an expandable detail panel showing stage-specific data.
//
// The currently-active stage (if the pipeline is mid-run) gets a pulsing
// marker. Completed stages get a solid number marker.
// ============================================================================

'use client';

import { useState } from 'react';
import type { JourneyEvent } from '@/lib/daily/journey';
import StageDetailCard from './StageDetailCard';
import styles from './page.module.scss';

interface JourneyTimelineProps {
  events: JourneyEvent[];
  /** When true, the last event is shown as "in progress" rather than completed */
  inProgress?: boolean;
}

export default function JourneyTimeline({ events, inProgress = false }: JourneyTimelineProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggle(idx: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  if (events.length === 0) {
    return null;
  }

  return (
    <div className={styles.journey}>
      {events.map((event, idx) => {
        const isLast = idx === events.length - 1;
        const isActive = isLast && inProgress;
        const isExpanded = expanded.has(idx);

        return (
          <div key={`${event.step}-${idx}`} className={styles.journeyEvent}>
            <div
              className={`${styles.journeyMarker} ${isActive ? styles.journeyMarkerActive : ''}`}
            >
              {event.stage}
            </div>
            <div className={styles.journeyBody}>
              <div className={styles.journeyHeader}>
                <div className={styles.journeyStage}>{event.stageName}</div>
                <h3 className={styles.journeyTitle}>{event.title}</h3>
              </div>
              <p className={styles.journeyDescription}>{event.description}</p>
              {hasDetail(event) && (
                <button
                  type="button"
                  className={styles.journeyDetailToggle}
                  onClick={() => toggle(idx)}
                >
                  {isExpanded ? '▾ Hide detail' : '▸ Show detail'}
                </button>
              )}
              {isExpanded && hasDetail(event) && (
                <div className={styles.journeyDetail}>
                  <StageDetailCard event={event} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** True if this event has drill-down data worth showing. Some events
 *  (session_created, simple topic_selected) are headline-only. */
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
