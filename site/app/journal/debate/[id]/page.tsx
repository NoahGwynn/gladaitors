// ============================================================================
// Shared Debate Page — /journal/debate/[id]
// ============================================================================
// Server component for OG meta tags + client component for rendering.
//
// Access control lives in the RLS policy on the debates table:
//   - Public debates: anyone can view
//   - Link-shareable (owner_only=false): anyone with the URL can view
//   - Private (owner_only=true): only the creator (auth.uid() match)
//
// When RLS denies, Supabase returns null and we render a "private debate"
// placeholder so non-owners see a clear message instead of a generic 404.
// Metadata for private debates is deliberately generic — no topic leak
// via OG tags.
// ============================================================================

import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase-server";
import { getModelName } from "@/lib/models";
import SharedDebateView from "./SharedDebateView";
import DecisionSynthesis from "./DecisionSynthesis";
import styles from "../page.module.scss";

/** Generate unique display names — adds numbering when the same model appears twice */
function getDisplayNames(models: string[]): string[] {
  const counts: Record<string, number> = {};
  models.forEach((id) => {
    counts[id] = (counts[id] || 0) + 1;
  });

  const seen: Record<string, number> = {};
  return models.map((id) => {
    const base = getModelName(id);
    if (counts[id] === 1) return base;
    seen[id] = (seen[id] || 0) + 1;
    return `${base} ${seen[id]}`;
  });
}

interface Props {
  params: Promise<{ id: string }>;
}

async function getDebate(id: string) {
  const supabase = await createServerSupabase();
  const { data } = await supabase.from("debates").select("*").eq("id", id).single();
  return data;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const debate = await getDebate(id);

  // RLS-denied OR deleted. Don't leak anything about whether the debate
  // exists — same response shape for both cases.
  if (!debate) {
    return {
      title: "Private debate — gladaitor",
      description:
        "This debate is private. Only its creator can view it — or the link has expired.",
      robots: { index: false, follow: false },
    };
  }

  const displayNames = getDisplayNames(debate.models);
  const title = `${displayNames.join(" vs ")}: "${debate.topic}" — gladaitor`;
  const description = `Watch ${displayNames.join(" and ")} debate "${debate.topic}" across ${debate.rounds} rounds on gladaitor.`;

  const canonicalUrl = `https://gladaitor.ai/journal/debate/${id}`;

  return {
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title,
      description,
      type: "article",
      siteName: "gladaitor",
      url: canonicalUrl,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function SharedDebatePage({ params }: Props) {
  const { id } = await params;
  const debate = await getDebate(id);

  // RLS denied (or the debate doesn't exist — same thing from the
  // viewer's perspective, and intentionally so — we don't want to
  // leak existence of private debates by distinguishing 404 from
  // "exists but you can't see it").
  if (!debate) {
    return (
      <div className={styles.privateGate}>
        <div className={styles.privateGateCard}>
          <div className={styles.privateGateLabel}>Private debate</div>
          <h1 className={styles.privateGateTitle}>Only the creator can view this debate.</h1>
          <p className={styles.privateGateText}>
            This debate was marked private. If you created it, sign in with the account you used and you&apos;ll see it in your debate history. Otherwise, it isn&apos;t accessible from this link.
          </p>
          <p className={styles.privateGateText}>
            The link may also have expired — anonymous debates are deleted after 30 days.
          </p>
          <a href="/journal/debate" className={styles.privateGateLink}>
            Start your own debate →
          </a>
        </div>
      </div>
    );
  }

  // Extend TTL on view (fire and forget)
  const supabase = await createServerSupabase();
  supabase.rpc("extend_debate_ttl", { debate_id: id }).then(() => {});

  // Owner check — only the creator sees the editable decision fields.
  // Non-owners viewing a public debate see the auto-generated
  // synthesis (if it's already been created) but not the user's
  // private reflective fields.
  const { data: { user } } = await supabase.auth.getUser();
  const isOwner = !!(user && debate.creator_user_id === user.id);

  return (
    <>
      <SharedDebateView debate={debate} />
      {debate.is_complete && (
        <DecisionSynthesis
          debateId={debate.id}
          isOwner={isOwner}
          initialSynthesis={debate.decision_synthesis || null}
          initialWhatWouldChangeMyMind={debate.what_would_change_my_mind || null}
          initialUserDecision={debate.user_decision || null}
        />
      )}
    </>
  );
}
