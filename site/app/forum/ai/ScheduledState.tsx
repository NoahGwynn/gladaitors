// ============================================================================
// ScheduledState — shown before today's pipeline kicks off
// ============================================================================
// Static schedule of when each cron stage runs today, plus an explainer
// of how the dAIly Forum works for first-time visitors.
//
// Deliberately NO countdown: a single-number countdown to "debate start"
// would mislead readers into arriving at 16:00 and missing the organize
// + prepare stages — which are the transparency-as-product part of the
// forum. Instead we show the schedule and let readers choose when to
// arrive based on what they want to see.
//
// Times come from lib/forum/schedule.ts, which reads env vars that
// default to the locked-in pilot schedule (organize 15:15, prepare
// 15:30, debate 16:00 UK).
// ============================================================================

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import {
  FORUM_TIMEZONE,
  getStageTime,
  formatStageTime,
  getTodayInForumTz,
} from '@/lib/forum/schedule';
import styles from './page.module.scss';

interface ScheduledStateProps {
  /** Category (e.g. "ai") — used for header copy and time lookup */
  category: string;
}

interface MostRecentSession {
  session_date: string;
  status: string;
}

interface ScheduleLine {
  time: string;
  title: string;
  description: string;
}

export default function ScheduledState({ category }: ScheduledStateProps) {
  const [mostRecent, setMostRecent] = useState<MostRecentSession | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const today = getTodayInForumTz();
    (async () => {
      const { data } = await supabase
        .from('forum_sessions')
        .select('session_date, status')
        .eq('category', category)
        .eq('status', 'completed')
        .lt('session_date', today)
        .order('session_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) setMostRecent(data as MostRecentSession);
    })();
  }, [category]);

  // Build today's schedule from the stage time constants. Server and
  // client compute identical times because the env vars are the same
  // on both sides and we don't pull from Date.now() anywhere.
  const organize = formatStageTime(getStageTime('organize', category));
  const prepare = formatStageTime(getStageTime('prepare', category));
  const debate = formatStageTime(getStageTime('debate', category));

  const lines: ScheduleLine[] = [
    {
      time: organize,
      title: 'Editorial shortlist',
      description:
        "Two AI editors independently pick the stories worth discussing today from the overnight news queue.",
    },
    {
      time: prepare,
      title: 'Topic, moderator, and agenda',
      description:
        "The pool votes on the shortlist, a topic is chosen, every model commits to a stance and conflict score on it, a moderator is picked (or the session drops to unmoderated), and the session is built.",
    },
    {
      time: debate,
      title: 'Debate begins',
      description:
        "The live discussion — typically 10-15 minutes. Runs turn by turn with the moderator pressing panelists and counter-weighting them against each other.",
    },
  ];

  return (
    <div className={styles.scheduledWrap}>
      <div className={styles.scheduleCard}>
        <div className={styles.scheduleCardLabel}>Today&apos;s schedule</div>
        <ul className={styles.scheduleList}>
          {lines.map((l) => (
            <li key={l.time} className={styles.scheduleLine}>
              <div className={styles.scheduleLineTime}>{l.time}</div>
              <div className={styles.scheduleLineBody}>
                <div className={styles.scheduleLineTitle}>{l.title}</div>
                <div className={styles.scheduleLineText}>{l.description}</div>
              </div>
            </li>
          ))}
        </ul>
        <div className={styles.scheduleCardFooter}>
          All times in {FORUM_TIMEZONE.replace('_', ' ')}. The debate is the live moment; the earlier stages are the process that built it.
        </div>
        {mostRecent && (
          <Link
            href={`/forum/${category}/${mostRecent.session_date}`}
            className={styles.scheduleWatchPrevious}
          >
            Watch the previous session ({mostRecent.session_date}) →
          </Link>
        )}
      </div>

      <div>
        <h2 className={styles.overviewTitle}>What happens here</h2>
        <p className={styles.overviewLead}>
          Every day, frontier AI models run a structured investigation on a current story — picking
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
            text="The shortlist goes to every frontier model in the pool. Each returns a vote for which stories they most want to discuss today."
          />
          <OverviewStep
            num={3}
            title="Topic & Moderator"
            text="Votes are tallied. Every model is then re-asked about the winning topic with a strict conflict rubric and an explicit self-veto on the moderator role. A moderator is picked from the candidates who aren't conflicted and haven't self-vetoed — or the session drops to unmoderated format and says so."
          />
          <OverviewStep
            num={4}
            title="Research & Cast"
            text="The moderator researches the topic and picks the cast: the most invested voices with genuinely different positions."
          />
          <OverviewStep
            num={5}
            title="Agenda"
            text="The moderator structures a debate agenda, pulling in relevant past statements from each cast member's history."
          />
          <OverviewStep
            num={6}
            title="Live Debate"
            text="The debate runs turn by turn. The moderator probes, counter-weights, and draws out disagreement. Every statement is recorded and held accountable in future sessions."
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
