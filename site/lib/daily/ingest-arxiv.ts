// ============================================================================
// the dAIly — ArXiv API Ingester
// ============================================================================
// Pulls recent papers from ArXiv's Atom API for configured subject
// categories (cs.AI, cs.CL, cs.LG, etc.). Each paper becomes one
// forum_item with title, abstract as summary, and ArXiv ID as
// external_id.
//
// ArXiv API docs: https://info.arxiv.org/help/api/basics.html
// Rate limit: no auth required, but be polite — one request per source.
// ============================================================================

import { createClient } from '@/lib/supabase';

interface ArxivEntry {
  id: string;        // e.g. "http://arxiv.org/abs/2401.12345v1"
  title: string;
  summary: string;
  authors: string[];
  published: string; // ISO date
  link: string;      // abs link
  categories: string[];
}

/** Parse ArXiv Atom XML into structured entries. */
function parseArxivAtom(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];

  // Split on <entry> tags
  const entryBlocks = xml.split('<entry>').slice(1);

  for (const block of entryBlocks) {
    const endIdx = block.indexOf('</entry>');
    if (endIdx === -1) continue;
    const entry = block.slice(0, endIdx);

    const id = entry.match(/<id>(.*?)<\/id>/)?.[1] || '';
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
      .replace(/\s+/g, ' ').trim();
    const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '')
      .replace(/\s+/g, ' ').trim();
    const published = entry.match(/<published>(.*?)<\/published>/)?.[1] || '';

    // Extract authors
    const authors: string[] = [];
    const authorMatches = entry.matchAll(/<author>\s*<name>(.*?)<\/name>/g);
    for (const m of authorMatches) authors.push(m[1]);

    // Extract abs link
    const linkMatch = entry.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/);
    const link = linkMatch?.[1] || id.replace('/abs/', '/abs/');

    // Extract categories
    const cats: string[] = [];
    const catMatches = entry.matchAll(/category[^>]*term="([^"]+)"/g);
    for (const m of catMatches) cats.push(m[1]);

    if (title && id) {
      entries.push({ id, title, summary, authors, published, link, categories: cats });
    }
  }

  return entries;
}

/** Extract the ArXiv paper ID from the full URL (e.g., "2401.12345v1"). */
function extractArxivId(url: string): string {
  const match = url.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  return match ? match[0] : url;
}

interface IngestResult {
  sourceId: string;
  sourceName: string;
  fetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

/** Ingest papers from ArXiv for a configured source. */
export async function ingestArxiv(source: {
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
  const arxivCategories = (source.config.categories as string[]) || ['cs.AI'];
  const maxResults = (source.config.maxResults as number) || 50;
  const sortBy = (source.config.sortBy as string) || 'submittedDate';
  const sortOrder = (source.config.sortOrder as string) || 'descending';

  try {
    // Build the query — search across configured categories
    const catQuery = arxivCategories.map(c => `cat:${c}`).join('+OR+');
    const apiUrl = `${source.url}?search_query=${catQuery}&start=0&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=${sortOrder}`;

    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'gladaitor-pipeline/1.0 (https://gladaitor.ai)' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      result.errors.push(`HTTP ${res.status}`);
      return result;
    }

    const xml = await res.text();
    const entries = parseArxivAtom(xml);
    result.fetched = entries.length;

    for (const entry of entries) {
      const arxivId = extractArxivId(entry.id);
      const absUrl = `https://arxiv.org/abs/${arxivId}`;

      const { error: insertError } = await supabase
        .from('forum_items')
        .insert({
          source_id: source.id,
          categories: source.categories,
          external_id: arxivId,
          title: entry.title,
          summary: entry.summary.slice(0, 2000),
          url: absUrl,
          author: entry.authors.slice(0, 5).join(', ') || null,
          published_at: entry.published || null,
          engagement: {
            arxiv_categories: entry.categories,
          },
          raw_payload: {
            arxiv_id: arxivId,
            all_authors: entry.authors,
            categories: entry.categories,
          },
        })
        .select('id')
        .single();

      if (insertError) {
        if (insertError.code === '23505') result.skipped++;
        else result.errors.push(`${entry.title.slice(0, 60)}: ${insertError.message}`);
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
