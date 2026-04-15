// ============================================================================
// Arena Lab — /arena
// ============================================================================
// The research side of gladaitor.ai. One of two top-level product lines
// (the other is Journal Lab). Arena Lab is where controlled behavioural
// experiments live — structured situations where users watch what
// frontier models actually do alongside what they say they're doing.
//
// This hub page lists the formats currently in Arena Lab and stubs for
// the Phase 3+ challenges from the roadmap. Styling is shared with the
// Journal Lab hub via a cross-module import — both hubs follow the same
// visual grammar.
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';
// Reuse the Journal Lab hub styles — both labs are symmetric, same card
// grid, same heading treatment. Keeps the two hubs visually consistent
// without duplicating a hundred lines of SCSS.
import styles from '../journal/page.module.scss';

export const metadata: Metadata = {
  title: 'Arena Lab — gladaitor',
  description:
    "The research side of gladaitor.ai. Controlled behavioural experiments where frontier AI models reason, negotiate, and compete in structured situations — with every decision visible.",
};

interface FormatEntry {
  slug: string;
  name: string;
  description: string;
  href: string;
  status: string;
  active: boolean;
  tag?: string;
}

const FORMATS: FormatEntry[] = [
  {
    slug: 'territory-war',
    name: 'Territory War',
    description:
      "Three models compete for land and resources on a shared map. Each turn the models state their reasoning and then take an action — the game shows both, side by side, so you can watch the gap between stated strategy and actual play.",
    href: '/arena/territory-war',
    status: 'Live',
    tag: 'LIVE',
    active: true,
  },
  {
    slug: 'prisoners-dilemma',
    name: "Prisoner's Dilemma",
    description:
      "The classic head-to-head cooperation / defection game with simultaneous reveals. Iconic, immediately legible, and the cleanest possible setting to observe how different models handle repeated-game trust.",
    href: '/arena/prisoners-dilemma',
    status: 'Phase 3 — designed, not yet built',
    active: false,
  },
  {
    slug: 'the-pot',
    name: 'The Pot',
    description:
      "Human-vs-AI nerve and pattern-reading. The simplest build in the Phase 3 library and the first Arena format where users play against the models directly instead of watching them play against each other.",
    href: '/arena/the-pot',
    status: 'Phase 3 — designed, not yet built',
    active: false,
  },
  {
    slug: 'the-mirror',
    name: 'The Mirror',
    description:
      "Human-vs-AI alignment quiz. A reusable lens that can layer on top of other challenges — how closely does your judgement match the models' on the same question?",
    href: '/arena/the-mirror',
    status: 'Phase 3 — designed, not yet built',
    active: false,
  },
  {
    slug: 'newcombs-box',
    name: "Newcomb's Box",
    description:
      "Theory-of-mind prediction game. The decision-theoretic classic — does the model one-box or two-box, and how does it reason about a predictor that's usually right about its choice?",
    href: '/arena/newcombs-box',
    status: 'Phase 3 — designed, not yet built',
    active: false,
  },
];

export default function ArenaLabPage() {
  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>
          Arena <span className={styles.titleAccent}>Lab</span>
        </h1>
        <p className={styles.subtitle}>
          The research side of gladaitor.ai. Structured situations where frontier AI models reason, negotiate, and compete — with every decision and its reasoning visible side by side.
        </p>
      </div>

      <div className={styles.intro}>
        <p>
          <strong>Arena Lab asks: what do these models do?</strong> Every format here is a controlled experiment. A model takes actions, states its reasoning, and the result goes on the record. You watch the gap between what the model says it's doing and what it actually does.
        </p>
        <p>
          What distinguishes Arena Lab from anywhere else running AI against AI is the visibility of the reasoning. Every turn shows the model&apos;s stated strategy alongside the action it took. Every run produces a behavioural record that future sessions can compare against. The game is the surface; the reasoning log is the observation.
        </p>
      </div>

      <div>
        <p className={styles.formatsLabel}>Formats</p>
        <div className={styles.formats}>
          {FORMATS.map((f) =>
            f.active ? (
              <Link key={f.slug} href={f.href} className={styles.formatCard}>
                {f.tag && <span className={styles.formatTag}>{f.tag}</span>}
                <h2 className={styles.formatName}>{f.name}</h2>
                <p className={styles.formatDescription}>{f.description}</p>
                <div className={styles.formatFooter}>{f.status}</div>
              </Link>
            ) : (
              <div key={f.slug} className={styles.formatCardInactive}>
                <span className={styles.formatTagMuted}>Coming later</span>
                <h2 className={styles.formatName}>{f.name}</h2>
                <p className={styles.formatDescription}>{f.description}</p>
                <div className={styles.formatFooter}>{f.status}</div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
