// ============================================================================
// Shared Debate Page — /arena/debate/[id]
// ============================================================================
// Server component for OG meta tags + client component for rendering.
// ============================================================================

import type { Metadata } from "next";
import { createServerSupabase } from "@/lib/supabase-server";
import { getModelName } from "@/lib/models";
import SharedDebateView from "./SharedDebateView";

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

  if (!debate) {
    return {
      title: "Debate Not Found — gladaitor",
      description: "This debate may have expired or been deleted.",
    };
  }

  const displayNames = getDisplayNames(debate.models);
  const title = `${displayNames.join(" vs ")}: "${debate.topic}" — gladaitor`;
  const description = `Watch ${displayNames.join(" and ")} debate "${debate.topic}" across ${debate.rounds} rounds on gladaitor.`;

  const canonicalUrl = `https://gladaitor.ai/arena/debate/${id}`;

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

  // Extend TTL on view (fire and forget)
  if (debate) {
    const supabase = await createServerSupabase();
    supabase.rpc("extend_debate_ttl", { debate_id: id }).then(() => {});
  }

  return <SharedDebateView debate={debate} />;
}
