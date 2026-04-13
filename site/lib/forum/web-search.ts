// ============================================================================
// dAIly Forum — Web Search (Tavily)
// ============================================================================
// Wrapper around Tavily for moderator-driven web research during deep
// research (Stage 5c-i). Tavily is purpose-built for AI agents — it
// returns extracted page content already, so we don't need a separate
// readability fetch round for web results.
//
// Used in the two-phase deep research flow:
//   Phase A — moderator reads DB sources and generates 3-5 search queries
//   Phase B — this module runs those queries via Tavily
//   Phase C — moderator synthesises with both DB + web results
//
// Cost: ~$0.04 per advanced search with raw content. ~5 queries per
// session × 6 categories = ~$1.20/day at full scale. Tavily's free
// tier covers ~1000 queries/month — plenty for development.
//
// Graceful failure: if TAVILY_API_KEY is missing or the API errors,
// we return an empty result with the error attached. The caller
// continues with DB sources only — the moderator's synthesis still
// works, just without web augmentation.
// ============================================================================

import { tavily } from '@tavily/core';

// --- Types ---

export interface WebSearchResult {
  /** Result URL */
  url: string;
  /** Page title */
  title: string;
  /** Short snippet returned by Tavily (always present) */
  snippet: string;
  /** Full extracted page content (when includeRawContent: true).
   *  Null if Tavily couldn't extract or if the page was too long. */
  fullText: string | null;
  /** Tavily's internal relevance score (0-1) */
  score: number;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  /** Error message if the query failed entirely. Empty results on success. */
  error: string | null;
}

// --- Constants ---

/** Cap on text length per result — multi-page articles can be very long
 *  and we don't need every word for moderator synthesis. ~6000 chars
 *  is roughly 1500 tokens per source, plenty for context. */
const MAX_TEXT_LENGTH = 6000;

/** Default results per query — 5 is a reasonable balance between coverage
 *  and prompt size. */
const DEFAULT_MAX_RESULTS = 5;

// --- Single search ---

/** Run one web search query via Tavily. Returns extracted text content
 *  for each result. Gracefully handles missing API key (returns empty
 *  with error attached) and API failures (same). */
export async function searchWeb(
  query: string,
  options: {
    maxResults?: number;
    searchDepth?: 'basic' | 'advanced';
  } = {},
): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('[WEB-SEARCH] TAVILY_API_KEY missing — skipping web search');
    return {
      query,
      results: [],
      error: 'TAVILY_API_KEY not configured',
    };
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const searchDepth = options.searchDepth ?? 'advanced';

  try {
    const client = tavily({ apiKey });
    const response = await client.search(query, {
      searchDepth,
      maxResults,
      // 'markdown' returns clean text with structural cues; better than
      // 'text' for moderator synthesis because it preserves headings.
      includeRawContent: 'markdown',
    });

    interface TavilyResult {
      url?: string;
      title?: string;
      content?: string;
      rawContent?: string | null;
      score?: number;
    }
    const rawResults: TavilyResult[] = (response.results || []) as TavilyResult[];

    const results: WebSearchResult[] = rawResults.map(r => {
      let fullText: string | null = r.rawContent ?? null;
      if (fullText && fullText.length > MAX_TEXT_LENGTH) {
        fullText = fullText.slice(0, MAX_TEXT_LENGTH) + '\n\n[...truncated for length]';
      }
      return {
        url: r.url ?? '',
        title: r.title ?? '',
        snippet: r.content ?? '',
        fullText,
        score: typeof r.score === 'number' ? r.score : 0,
      };
    });

    console.log(`[WEB-SEARCH] "${query.slice(0, 60)}" → ${results.length} results`);
    return { query, results, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn(`[WEB-SEARCH] "${query.slice(0, 60)}" failed: ${msg}`);
    return { query, results: [], error: msg };
  }
}

// --- Batch ---

/** Run multiple search queries in parallel. Each query gets its own
 *  WebSearchResponse — failures are isolated per-query so one bad
 *  query doesn't kill the others. */
export async function searchWebBatch(
  queries: string[],
  options?: {
    maxResults?: number;
    searchDepth?: 'basic' | 'advanced';
  },
): Promise<WebSearchResponse[]> {
  if (queries.length === 0) return [];
  return Promise.all(queries.map(q => searchWeb(q, options)));
}
