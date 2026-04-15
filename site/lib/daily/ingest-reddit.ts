// ============================================================================
// the dAIly — Reddit API Ingester
// ============================================================================
// Pulls hot posts from configured subreddits via Reddit's public JSON
// API. Each post becomes one forum_item with the Reddit post ID as
// external_id and engagement signals (upvotes, comment count).
//
// Uses the public JSON endpoints (append .json to any Reddit URL).
// No OAuth required. Rate limit: be polite, one request per subreddit.
// User-Agent is required or Reddit returns 429.
// ============================================================================

import { createClient } from '@/lib/supabase';

interface RedditPost {
  id: string;
  title: string;
  selftext?: string;
  url?: string;
  permalink: string;
  author: string;
  score: number;
  num_comments: number;
  created_utc: number;
  is_self: boolean;
  link_flair_text?: string;
}

interface IngestResult {
  sourceId: string;
  sourceName: string;
  fetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

/** Ingest hot posts from a single subreddit. */
export async function ingestReddit(source: {
  id: string;
  categories: string[];
  name: string;
  url: string;
  config: Record<string, unknown>;
}): Promise<IngestResult> {
  const result: IngestResult = {
    sourceId: source.id,
    sourceName: source.name,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
  };

  const supabase = createClient();
  const limit = (source.config.limit as number) || 25;

  try {
    const res = await fetch(
      `${source.url}?limit=${limit}&raw_json=1`,
      {
        headers: {
          'User-Agent': 'gladaitor-pipeline:v1.0 (by /u/gladaitor_ai)',
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) {
      result.errors.push(`HTTP ${res.status}`);
      return result;
    }

    const data = await res.json();
    const posts: RedditPost[] = (data?.data?.children || [])
      .map((c: { data: RedditPost }) => c.data)
      .filter((p: RedditPost) => p && p.title);

    result.fetched = posts.length;

    for (const post of posts) {
      // For link posts, use the external URL. For self posts, use the Reddit permalink.
      const url = post.is_self
        ? `https://www.reddit.com${post.permalink}`
        : (post.url || `https://www.reddit.com${post.permalink}`);

      const summary = post.selftext
        ? post.selftext.slice(0, 2000).trim()
        : null;

      const { error: insertError } = await supabase
        .from('forum_items')
        .insert({
          source_id: source.id,
          categories: source.categories,
          external_id: post.id,
          title: post.title,
          summary,
          url,
          author: post.author || null,
          published_at: new Date(post.created_utc * 1000).toISOString(),
          engagement: {
            score: post.score,
            comments: post.num_comments,
            flair: post.link_flair_text || null,
            reddit_url: `https://www.reddit.com${post.permalink}`,
          },
          raw_payload: {
            reddit_id: post.id,
            is_self: post.is_self,
            score: post.score,
            num_comments: post.num_comments,
            flair: post.link_flair_text,
          },
        })
        .select('id')
        .single();

      if (insertError) {
        if (insertError.code === '23505') result.skipped++;
        else result.errors.push(`${post.title.slice(0, 60)}: ${insertError.message}`);
      } else {
        result.inserted++;
      }
    }

    await supabase
      .from('forum_sources')
      .update({ last_fetched_at: new Date().toISOString(), last_error: null })
      .eq('id', source.id);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    result.errors.push(msg);
    await supabase
      .from('forum_sources')
      .update({ last_error: msg })
      .eq('id', source.id);
  }

  return result;
}
