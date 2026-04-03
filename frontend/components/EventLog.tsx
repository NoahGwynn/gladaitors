// ============================================================================
// EventLog — horizontal scrolling ticker showing recent game events
// ============================================================================
// New events prepend left, old events scroll right and fade out.
// Model names are colour-coded using their identity colour.
//
// Usage:
//   <EventLog events={gameState.events} />
// ============================================================================

'use client';

import { useEffect, useRef } from 'react';
import type { GameEvent } from '@/lib/types';
import styles from './EventLog.module.scss';

interface EventLogProps {
  events: GameEvent[];
}

export default function EventLog({ events }: EventLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to show newest events (left side)
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = 0;
    }
  }, [events]);

  return (
    <div className={styles.eventLog} ref={containerRef}>
      {events.map((event, i) => (
        <span key={`${event.tick}-${i}`}>
          <span className={styles.event}>
            <span className={styles.eventTick}>[Turn {event.tick}]</span>
            <span>{event.message}</span>
          </span>
          {i < events.length - 1 && (
            <span className={styles.separator}>&middot;</span>
          )}
        </span>
      ))}
    </div>
  );
}
