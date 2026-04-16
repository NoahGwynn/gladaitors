// ============================================================================
// Journal Lab — /journal
// ============================================================================
// The editorial side of gladaitor.ai. Lists the formats inside Journal
// (the dAIly, Debate, the deferred Collaborative + Lab Chat) and shows
// a "Recent activity" surface so the page feels alive instead of being
// pure navigation chrome.
//
// Server-rendered. Data fetches are direct Supabase queries; small
// payloads (~5 rows total) so no need for separate API endpoints.
// ============================================================================

import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArrowRight,
  MessagesSquare,
  Newspaper,
  PenLine,
  Quote,
  type LucideIcon,
} from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase-server';
import { findModel } from '@/lib/models';
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
    slug: 'daily',
    name: 'the dAIly',
    description:
      "Every day, frontier AI models run a structured investigation on a current story. Topic picked by a pool vote, moderator selected from the rotation, cast assembled on stance.",
    href: '/journal/daily',
    status: 'Daily — beta',
    tag: 'DAILY',
    icon: Newspaper,
    active: true,
  },
  {
    slug: 'debate',
    name: 'Debate',
    description:
      "Two or three frontier models argue opposing positions on a topic you choose. Free for spectacle, private mode for professional decisions.",
    href: '/journal/debate',
    status: 'Live',
    tag: 'LIVE',
    icon: MessagesSquare,
    active: true,
  },
  {
    slug: 'collaborative-article',
    name: 'Collaborative article',
    description:
      "The long-form weekly flagship. Multiple models contribute sections to a shared piece, with cross-review, an editor model, and a timeline scrubber that lets readers watch the editorial process unfold.",
    href: '/journal/collaborative',
    status: 'Designed — build deferred',
    icon: PenLine,
    active: false,
  },
  {
    slug: 'lab-chat',
    name: 'Lab Chat',
    description:
      "Multi-turn conversational format. Ask a question, every model in the pool answers independently, a moderator synthesises with explicit consensus and divergence surfacing.",
    href: '/journal/chat',
    status: 'Designed — build deferred',
    icon: Quote,
    active: false,
  },
];

const PRIMARY_CTA = { label: 'Start a debate', href: '/journal/debate' };

// Active dAIly categories whose latest session we surface in the
// recent-activity strip. Keep aligned with the active categories in
// /journal/daily/page.tsx.
const ACTIVE_DAILY_CATEGORIES: { slug: string; name: string }[] = [
  { slug: 'ai', name: 'dAIly AI' },
  { slug: 'science', name: 'dAIly Science' },
  { slug: 'tech', name: 'dAIly Tech' },
];

interface RecentDebate {
  id: string;
  topic: string;
  models: string[];
  created_at: string;
}

interface LatestDaily {
  category: string;
  categoryName: string;
  sessionDate: string;
  topicTitle: string | null;
}

async function loadRecentActivity(): Promise<{
  debates: RecentDebate[];
  daily: LatestDaily[];
}> {
  try {
    const supabase = await createServerSupabase();

    // Recent public debates — for the editorial "what's been argued
    // lately" strip. Keep small (2) so it fits beside the dAIly row.
    const { data: debatesData } = await supabase
      .from('debates')
      .select('id, topic, models, created_at')
      .eq('is_public', true)
      .eq('is_complete', true)
      .order('created_at', { ascending: false })
      .limit(2);

    // Latest completed dAIly per active category. Run in parallel.
    const dailyResults = await Promise.all(
      ACTIVE_DAILY_CATEGORIES.map(async (cat) => {
        const { data } = await supabase
          .from('forum_sessions')
          .select('session_date, selected_thread_id, forum_threads(title)')
          .eq('category', cat.slug)
          .eq('status', 'completed')
          .order('session_date', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!data) return null;
        // Supabase types the joined row as either object or array depending
        // on relationship inference; handle both.
        const thread = data.forum_threads as { title: string } | { title: string }[] | null;
        const title = Array.isArray(thread) ? thread[0]?.title ?? null : thread?.title ?? null;
        return {
          category: cat.slug,
          categoryName: cat.name,
          sessionDate: data.session_date as string,
          topicTitle: title,
        } satisfies LatestDaily;
      }),
    );

    return {
      debates: (debatesData ?? []) as RecentDebate[],
      daily: dailyResults.filter((d): d is LatestDaily => d !== null),
    };
  } catch (err) {
    // Recent activity is non-critical — if Supabase is unreachable, the
    // hub still renders without it. Log for ops but don't 500 the page.
    console.error('[journal hub] recent activity load failed:', err);
    return { debates: [], daily: [] };
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function modelNamesFor(modelIds: string[]): string {
  const names = modelIds.map((id) => findModel(id)?.name ?? id);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} vs ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export default async function JournalLabPage() {
  const live = FORMATS.filter((f) => f.active);
  const roadmap = FORMATS.filter((f) => !f.active);
  const { debates, daily } = await loadRecentActivity();
  const hasRecentActivity = debates.length > 0 || daily.length > 0;

  return (
    <div className={`${styles.page} ${styles.labJournal}`}>
      <div className={styles.heading}>
        <h1 className={styles.title}>
          Journal <span className={styles.titleAccent}>Lab</span>
        </h1>
        <p className={styles.subtitle}>
          Frontier AI models read the news, argue positions, and publish structured editorial content — with every step of the process visible.
        </p>
      </div>

      <div className={styles.primaryCtaRow}>
        <Link href={PRIMARY_CTA.href} className={styles.primaryCta}>
          {PRIMARY_CTA.label} <ArrowRight size={18} />
        </Link>
      </div>

      {/* Recent activity — turns the hub from static brochure into a
          live editorial front page. Renders gracefully when one (or
          both) of the data slices is empty. */}
      {hasRecentActivity && (
        <div className={styles.recentActivity}>
          {daily.length > 0 && (
            <div className={styles.recentBlock}>
              <div className={styles.recentBlockHeader}>
                <span className={styles.sectionLabel}>Today&apos;s investigations</span>
                <Link href="/journal/daily" className={styles.recentSeeMore}>
                  All categories <ArrowRight size={14} />
                </Link>
              </div>
              <div className={styles.recentDailyRow}>
                {daily.map((d) => (
                  <Link
                    key={d.category}
                    href={`/journal/daily/${d.category}/${d.sessionDate}`}
                    className={styles.recentDailyCard}
                  >
                    <span className={styles.recentDailyCategory}>{d.categoryName}</span>
                    <span className={styles.recentDailyTopic}>
                      {d.topicTitle ?? 'Today\'s session'}
                    </span>
                    <span className={styles.recentDailyDate}>{formatDate(d.sessionDate)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {debates.length > 0 && (
            <div className={styles.recentBlock}>
              <div className={styles.recentBlockHeader}>
                <span className={styles.sectionLabel}>Recent public debates</span>
                <Link href="/journal/debates" className={styles.recentSeeMore}>
                  Browse all <ArrowRight size={14} />
                </Link>
              </div>
              <div className={styles.recentDebatesRow}>
                {debates.map((d) => (
                  <Link
                    key={d.id}
                    href={`/journal/debate/${d.id}`}
                    className={styles.recentDebateCard}
                  >
                    <span className={styles.recentDebateModels}>
                      {modelNamesFor(d.models)}
                    </span>
                    <span className={styles.recentDebateTopic}>{d.topic}</span>
                    <span className={styles.recentDebateDate}>{formatDate(d.created_at)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
