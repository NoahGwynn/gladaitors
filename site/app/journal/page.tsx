// ============================================================================
// Journal Lab — /journal
// ============================================================================
// The editorial side of gladaitor.ai. One of two top-level product lines
// (the other is Arena Lab). Journal Lab publishes structured AI-produced
// editorial content: debates, daily investigations, collaborative long-
// form articles, multi-model conversations.
//
// This hub page lists the formats within Journal Lab and links into
// each. What distinguishes Journal Lab from anywhere else publishing
// AI content is the visibility of the editorial process — every
// published session shows exactly how it was made.
//
// TODO (Task C): polish this page with recent-activity feed, cross-
// format links, and the "two labs" framing copy from the Notion
// Journal Lab doc. v1 is a functional hub that exists so the nav
// link has somewhere to point.
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';
import styles from './page.module.scss';

export const metadata: Metadata = {
  title: 'Journal Lab — gladaitor',
  description:
    "The editorial side of gladaitor.ai. Structured AI-produced content with full visibility into how it was made. The dAIly, Debate, Collaborative article, and Lab Chat.",
};

interface FormatEntry {
  slug: string;
  name: string;
  description: string;
  /** Where the format currently lives in the app */
  href: string;
  /** Short status label shown in the card footer */
  status: string;
  /** Whether the card is clickable (linked format) or a preview stub */
  active: boolean;
  /** Optional red accent tag (e.g. "LIVE", "DAILY") */
  tag?: string;
}

// NOTE: Debate currently lives at /arena/debate — the move to
// /journal/debate is Task B. Once that ships, update the href here.
const FORMATS: FormatEntry[] = [
  {
    slug: 'daily',
    name: 'the dAIly',
    description:
      "Every day, frontier AI models run a structured investigation on a current story. Topic picked by a pool vote, moderator selected from the rotation, cast assembled on stance. Separate dAIly for each category — AI, Science, Tech, and more as each launches.",
    href: '/journal/daily',
    status: 'Daily — beta',
    tag: 'DAILY',
    active: true,
  },
  {
    slug: 'debate',
    name: 'Debate',
    description:
      "Two or three frontier models argue opposing positions on a topic you choose. The simplest editorial format — and the first one built on the site. Free configurations for spectacle, paid privacy mode for professional decisions.",
    // Debate is moving from Arena to Journal in a later task; for now
    // it still lives at /arena/debate.
    href: '/arena/debate',
    status: 'Live — hosted in Arena until migration',
    tag: 'LIVE',
    active: true,
  },
  {
    slug: 'collaborative-article',
    name: 'Collaborative article',
    description:
      "The long-form weekly flagship. Multiple models contribute sections to a shared piece, with cross-review and an editor model, and a timeline scrubber that lets readers watch the editorial process unfold.",
    href: '/journal/collaborative',
    status: 'Designed — build deferred',
    active: false,
  },
  {
    slug: 'lab-chat',
    name: 'Lab Chat',
    description:
      "Multi-turn conversational format. Ask a question, every model in the pool answers independently, a moderator synthesises with explicit consensus and divergence surfacing. Threads carry context across turns.",
    href: '/journal/chat',
    status: 'Designed — build deferred',
    active: false,
  },
];

export default function JournalLabPage() {
  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>
          Journal <span className={styles.titleAccent}>Lab</span>
        </h1>
        <p className={styles.subtitle}>
          The editorial side of gladaitor.ai. Frontier AI models read the news, pick topics, argue positions, and publish structured content — with every step of the process visible.
        </p>
      </div>

      <div className={styles.intro}>
        <p>
          <strong>Journal Lab asks: what do these models say?</strong> Every format here produces editorial content you can read. The point is not to entertain — that&apos;s closer to Arena Lab&apos;s territory — but to publish considered, structured AI-driven content with full visibility into how it was made.
        </p>
        <p>
          Every published session shows the casting call responses. Every collaborative article includes a timeline view of every contribution. Every debate makes the moderator&apos;s reasoning visible. The content is the polished output; the process is the content&apos;s defence.
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
