// ============================================================================
// dAIly Forum — Readability Fetcher
// ============================================================================
// Fetches a URL and parses the article content out using Mozilla
// Readability (the same engine Firefox Reader View uses). Returns
// clean plain text suitable for moderator deep research.
//
// This is the "fetch" mode the Notion data pipeline doc describes:
// not scraping (no maintenance burden) — just requesting URLs we already
// have from feeds and parsing them through a readability extractor,
// the same way every "read later" app does.
//
// Failure modes handled gracefully:
// - Timeouts (default 10s per URL)
// - Non-200 status codes
// - Sites that need JS rendering (we don't have a headless browser)
// - Sites that block our User-Agent
// - HTML that doesn't parse cleanly through Readability
//
// On any failure, returns { text: null, error } and the caller skips
// this item rather than blowing up the whole research call.
// ============================================================================

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

// --- Types ---

export interface ReadableArticle {
  /** Cleaned plain text body of the article. Null if extraction failed. */
  text: string | null;
  /** Article title as extracted by Readability (may differ from feed title). */
  title: string | null;
  /** Author byline if extracted. */
  byline: string | null;
  /** Word count of the extracted text. */
  wordCount: number;
  /** Error message if extraction failed. Null on success. */
  error: string | null;
}

// --- Constants ---

/** Default timeout per fetch — 10 seconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Sensible User-Agent — identifies us honestly without lying about being
 *  a browser. Most publishers serve content fine to identified bots; the
 *  ones that block us we'd rather skip than spoof. */
const USER_AGENT =
  'gladaitor-forum/1.0 (+https://gladaitor.ai; daily AI investigation forum)';

/** Maximum text length we keep — multi-page articles can run very long
 *  and we don't need every word for moderator synthesis. Cap at ~30k
 *  characters which is roughly 5-6k tokens, plenty for context. */
const MAX_TEXT_LENGTH = 30_000;

// --- Main entry point ---

/** Fetch a URL and extract the readable article body. Always returns
 *  a ReadableArticle — on failure, text is null and error is populated.
 *  The caller decides how to handle failures (typically: skip the item
 *  and continue with the rest). */
export async function fetchReadable(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ReadableArticle> {
  const empty = (error: string): ReadableArticle => ({
    text: null,
    title: null,
    byline: null,
    wordCount: 0,
    error,
  });

  // Validate the URL early
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return empty(`Invalid URL: ${url}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return empty(`Unsupported protocol: ${parsedUrl.protocol}`);
  }

  // Fetch with timeout via AbortController
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      return empty(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('html')) {
      return empty(`Unsupported content-type: ${contentType}`);
    }

    html = await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return empty(`Timeout after ${timeoutMs}ms`);
    }
    return empty(`Fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Parse and extract
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return empty('Readability extracted no content');
    }

    let text = article.textContent.trim();
    // Collapse runs of whitespace — Readability sometimes leaves big gaps
    text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ');

    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n[...truncated for length]';
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return {
      text,
      title: article.title || null,
      byline: article.byline || null,
      wordCount,
      error: null,
    };
  } catch (err) {
    return empty(`Parse failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

/** Fetch multiple URLs in parallel with the same timeout each. Returns
 *  results in the same order as the input URLs. Failures are non-fatal
 *  — each failed URL has text: null and an error message. */
export async function fetchReadableBatch(
  urls: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ReadableArticle[]> {
  return Promise.all(urls.map(url => fetchReadable(url, timeoutMs)));
}
