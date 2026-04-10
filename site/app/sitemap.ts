import type { MetadataRoute } from "next";
import { createServerSupabase } from "@/lib/supabase-server";

const BASE = "https://gladaitor.ai";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${BASE}/arena/debate`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${BASE}/explore`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE}/terms`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${BASE}/privacy`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  // Dynamic pages — every public, completed debate gets its own entry.
  // Each is a unique page with unique content, proper meta tags, and a
  // stable URL. Adding them here means Google discovers and indexes them
  // faster than waiting for crawl-through from the explore feed.
  let debatePages: MetadataRoute.Sitemap = [];
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase
      .from("debates")
      .select("id, created_at")
      .eq("is_public", true)
      .eq("is_complete", true)
      .order("created_at", { ascending: false })
      .limit(1000);

    if (data) {
      debatePages = data.map((d) => ({
        url: `${BASE}/arena/debate/${d.id}`,
        lastModified: new Date(d.created_at),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      }));
    }
  } catch {
    // If the DB query fails, just return static pages — sitemap
    // generation shouldn't break the build.
  }

  return [...staticPages, ...debatePages];
}
