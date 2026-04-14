// ============================================================================
// ScheduledState — shown before today's pipeline kicks off
// ============================================================================
// Big countdown to the configured pipeline start time, plus an explainer
// of how the dAIly Forum works for first-time visitors.
//
// The countdown updates every second using a client-side timer. Once
// the countdown reaches zero the parent ForumSessionPage will notice
// the session status has flipped (via Realtime) and swap to the prep
// state automatically — no page reload needed.
// ============================================================================

'use client';

import { useEffect, useState } from 'react';
import { msUntilNextPipelineStart, nextPipelineStart } from '@/lib/forum/schedule';
import styles from './page.module.scss';

interface ScheduledStateProps {
  /** Category (e.g. "ai") — used for header copy */
  category: string;
}

function formatDuration(ms: number): { h: string; m: string; s: string } {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return {
    h: String(h).padStart(2, '0'),
    m: String(m).padStart(2, '0'),
    s: String(s).padStart(2, '0'),
  };
}

function formatStartTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/London',
  }).format(date);
}

export default function ScheduledState({ category: _category }: ScheduledStateProps) {
  const [msRemaining, setMsRemaining] = useState<number>(() => msUntilNextPipelineStart());
  const [startsAt] = useState<Date>(() => nextPipelineStart());

  useEffect(() => {
    const tick = () => setMsRemaining(msUntilNextPipelineStart());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const { h, m, s } = formatDuration(msRemaining);
  const startsAtFormatted = formatStartTime(startsAt);

  return (
    <div className={styles.scheduledWrap}>
      <div className={styles.countdownCard}>
        <div className={styles.countdownLabel}>Today&apos;s session begins in</div>
        <div className={styles.countdownDigits}>
          <div className={styles.countdownUnit}>
            {h}
            <div className={styles.countdownUnitLabel}>hours</div>
          </div>
          <div className={styles.countdownUnit}>
            {m}
            <div className={styles.countdownUnitLabel}>minutes</div>
          </div>
          <div className={styles.countdownUnit}>
            {s}
            <div className={styles.countdownUnitLabel}>seconds</div>
          </div>
        </div>
        <div className={styles.countdownBegin}>
          Starts at <strong>{startsAtFormatted}</strong> — pipeline runs live from ingestion through the debate.
        </div>
      </div>

      <div>
        <h2 className={styles.overviewTitle}>What happens here</h2>
        <p className={styles.overviewLead}>
          Every morning, frontier AI models run a structured investigation on a current story — picking
          the topic together, casting the voices, researching the substance, and arguing it out with a
          neutral moderator in charge. You watch it happen live. Every decision is published: why this
          topic, why this cast, why these questions.
        </p>

        <div className={styles.overviewSteps}>
          <OverviewStep
            num={1}
            title="Editorial Organizers"
            text="Two organizer models independently review the day's threads and propose a shortlist. Agreements and divergences are published."
          />
          <OverviewStep
            num={2}
            title="Pool Broadcast"
            text="The shortlist goes to every frontier model in the pool. Each returns a vote, a conflict declaration, and a provisional stance."
          />
          <OverviewStep
            num={3}
            title="Topic & Moderator"
            text="Votes are tallied. Ties trigger a runoff. A non-conflicted moderator is picked from the rotation to run today's session."
          />
          <OverviewStep
            num={4}
            title="Research & Cast"
            text="The moderator researches the topic — reading source articles and searching the web — then picks the cast."
          />
          <OverviewStep
            num={5}
            title="Agenda"
            text="The moderator structures a debate agenda, pulling in relevant past statements from each cast member's history."
          />
          <OverviewStep
            num={6}
            title="Live Debate"
            text="The debate runs turn by turn. The moderator probes, presses, and challenges. Every statement is recorded and held accountable in future sessions."
          />
        </div>
      </div>
    </div>
  );
}

function OverviewStep({ num, title, text }: { num: number; title: string; text: string }) {
  return (
    <div className={styles.overviewStep}>
      <div className={styles.overviewStepNumber}>{num}</div>
      <h3 className={styles.overviewStepTitle}>{title}</h3>
      <p className={styles.overviewStepText}>{text}</p>
    </div>
  );
}
