// ============================================================================
// Arena Lab — /arena
// ============================================================================
// The research side of gladaitor.ai. One of two top-level product lines
// (the other is Journal Lab). Arena Lab is where controlled behavioural
// experiments live — structured situations where users watch what
// frontier models actually do alongside what they say they're doing.
//
// Layer 1+2 of the lab redesign — same shape as the Journal Lab hub
// (icons, CTA, roadmap section) but Arena keeps the default darker
// tone (no .labJournal modifier). Subpages will follow this pattern
// in Layer 3.
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArrowRight,
  Crown,
  Handshake,
  Coins,
  ScanFace,
  Box,
  type LucideIcon,
} from 'lucide-react';
// Reuse the Journal Lab hub styles — both labs share the visual
// grammar; Arena just doesn't apply the .labJournal tone modifier.
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
  icon: LucideIcon;
  /** Optional image URL — when set, replaces the icon. Reserved for the
   *  bespoke artwork the user is preparing for each format. */
  image?: string;
}

const FORMATS: FormatEntry[] = [
  {
    slug: 'territory-war',
    name: 'Territory War',
    description:
      "Three models compete for land and resources on a shared map. Each turn shows the model's stated reasoning alongside the action it took — watch the gap between strategy and play.",
    href: '/arena/territory-war',
    status: 'Live',
    tag: 'LIVE',
    icon: Crown,
    active: true,
  },
  {
    slug: 'prisoners-dilemma',
    name: "Prisoner's Dilemma",
    description:
      "The classic head-to-head cooperation / defection game with simultaneous reveals. The cleanest possible setting to observe how different models handle repeated-game trust.",
    href: '/arena/prisoners-dilemma',
    status: 'Phase 3 — designed, not yet built',
    icon: Handshake,
    active: false,
  },
  {
    slug: 'the-pot',
    name: 'The Pot',
    description:
      "Human-vs-AI nerve and pattern-reading. The first Arena format where users play against the models directly instead of watching them play each other.",
    href: '/arena/the-pot',
    status: 'Phase 3 — designed, not yet built',
    icon: Coins,
    active: false,
  },
  {
    slug: 'the-mirror',
    name: 'The Mirror',
    description:
      "Human-vs-AI alignment quiz. A reusable lens that can layer on top of other challenges — how closely does your judgement match the models' on the same question?",
    href: '/arena/the-mirror',
    status: 'Phase 3 — designed, not yet built',
    icon: ScanFace,
    active: false,
  },
  {
    slug: 'newcombs-box',
    name: "Newcomb's Box",
    description:
      "Theory-of-mind prediction game. Does the model one-box or two-box, and how does it reason about a predictor that's usually right about its choice?",
    href: '/arena/newcombs-box',
    status: 'Phase 3 — designed, not yet built',
    icon: Box,
    active: false,
  },
];

const PRIMARY_CTA = { label: 'Watch Territory War', href: '/arena/territory-war' };

export default function ArenaLabPage() {
  const live = FORMATS.filter((f) => f.active);
  const roadmap = FORMATS.filter((f) => !f.active);

  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>
          Arena <span className={styles.titleAccent}>Lab</span>
        </h1>
        <p className={styles.subtitle}>
          Structured situations where frontier AI models reason, negotiate, and compete — with every decision and its reasoning visible side by side.
        </p>
      </div>

      <div className={styles.primaryCtaRow}>
        <Link href={PRIMARY_CTA.href} className={styles.primaryCta}>
          {PRIMARY_CTA.label} <ArrowRight size={18} />
        </Link>
      </div>

      <div>
        <p className={styles.sectionLabel}>Live formats</p>
        <div className={styles.formats}>
          {live.map((f) => (
            <Link key={f.slug} href={f.href} className={styles.formatCard}>
              <div className={styles.formatHeader}>
                <span className={styles.formatVisual}>
                  {f.image ? <img src={f.image} alt="" /> : <f.icon size={28} />}
                </span>
                <div className={styles.formatHeaderText}>
                  {f.tag && <span className={styles.formatTag}>{f.tag}</span>}
                  <h2 className={styles.formatName}>{f.name}</h2>
                </div>
              </div>
              <p className={styles.formatDescription}>{f.description}</p>
              <div className={styles.formatFooter}>{f.status}</div>
            </Link>
          ))}
        </div>
      </div>

      {roadmap.length > 0 && (
        <div className={styles.roadmapSection}>
          <p className={styles.sectionLabel}>Roadmap — coming later</p>
          <div className={styles.roadmapGrid}>
            {roadmap.map((f) => (
              <div key={f.slug} className={styles.roadmapCard}>
                <span className={styles.roadmapVisual}>
                  {f.image ? <img src={f.image} alt="" /> : <f.icon size={18} />}
                </span>
                <div className={styles.roadmapBody}>
                  <h3 className={styles.roadmapName}>{f.name}</h3>
                  <span className={styles.roadmapStatus}>{f.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
