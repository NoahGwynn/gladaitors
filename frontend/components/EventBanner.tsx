// ============================================================================
// EventBanner — full-width dramatic notification for scripted events
// ============================================================================
// Slides in from top for 3 seconds, then slides out automatically.
// Re-renders with a new key to retrigger the animation for each event.
//
// Usage:
//   <EventBanner message="Tech giant announces record losses" />
//   {/* Pass null/undefined to hide */}
// ============================================================================

'use client';

import styles from './EventBanner.module.scss';

interface EventBannerProps {
  message: string | null;
  /** Unique key per event to retrigger the slide animation */
  eventKey?: string | number;
}

export default function EventBanner({ message, eventKey }: EventBannerProps) {
  if (!message) return null;

  return (
    <div className={styles.banner} key={eventKey}>
      <span className={styles.text}>{message}</span>
    </div>
  );
}
