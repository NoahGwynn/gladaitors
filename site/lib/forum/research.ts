// ============================================================================
// dAIly Forum — Research (Stages 5a + 5c-i)
// ============================================================================
// Two research modes for the moderator:
//
//   Stage 5a — researchTopicLight()
//     Works from the title + summary + url + source name we already
//     have stored on each forum_items row from RSS ingestion.
//     Cheap, fast, runs BEFORE cast selection. Gives the moderator
//     enough context to pick cast members substantively rather than
//     from headlines alone.
//
//   Stage 5c-i — researchTopicDeep()
//     Fetches the full article text via readability parser for the
//     2-5 most central items the light research identified. Sends
//     full text to the moderator in one bigger LLM call. Output is
//     a deeper synthesis with key claims, evidence snippets,
//     citations, and gaps in coverage. Runs AFTER cast selection
//     and BEFORE agenda build, so the agenda can be structured
//     around the actual substance of the source material.
//
// Both calls are to the moderator (chosen in Stage 4), identity-anchored
// via the shared buildIdentityAnchor helper.
// ============================================================================

import { callPoolModel, type PoolModel } from './model-pool';
import { buildIdentityAnchor } from './broadcast';
import { fetchReadableBatch, type ReadableArticle } from './readability';
import { searchWebBatch, type WebSearchResponse } from './web-search';

// --- Constants ---

/** Maximum web search queries the moderator can run per session.
 *  This is a soft signal — the moderator's prompt asks for 3-8 — and
 *  a hard cap on the parser. If we see the cap consistently being hit
 *  in production (signalled via webSearchesRequested > webSearches.length),
 *  it's a sign to bump this. Cost per query is ~$0.04 via Tavily. */
const MAX_WEB_QUERIES = 8;

// --- Types ---

export interface ResearchItem {
  /** The forum_items row id (for traceability) */
  id: string;
  title: string;
  summary: string | null;
  url: string;
  sourceName: string;
  publishedAt: string | null;
}

export interface ResearchResult {
  /** Synthesised facts the moderator considers established */
  synthesisedFacts: string[];
  /** Claims where sources disagree or are unverified */
  contestedClaims: string[];
  /** Open questions / areas of genuine uncertainty */
  openQuestions: string[];
  /** Brief timeline of how the story has developed */
  timeline: Array<{ date: string | null; event: string }>;
  /** Free-text overall summary the moderator wrote */
  overallSummary: string;
  /** Item ids the moderator considered most central, in order */
  centralItemIds: string[];
  /** Raw error if the call failed */
  error?: string;
}

// --- Build the research prompt ---

function buildResearchPrompt(
  threadTitle: string,
  threadSignificance: string[],
  items: ResearchItem[],
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly Forum session in the ${category.toUpperCase()} category. The pool has voted on candidate topics, you've been assigned as the moderator, and a topic has been selected. Before you pick the cast, you need to actually read the source material so your editorial judgment is informed by the substance, not just the headline.

Your job here is to synthesise the available source material into a research note. You are NOT picking the cast yet, NOT building the agenda, NOT taking a stance. You are reading and synthesising — like a producer briefing themselves before they decide who to invite on stage.`;

  const itemBlocks = items.map((item, i) => {
    const lines = [
      `[${i + 1}] ID: ${item.id}`,
      `    Source: ${item.sourceName}`,
      `    Title: ${item.title}`,
    ];
    if (item.publishedAt) lines.push(`    Published: ${item.publishedAt.split('T')[0]}`);
    if (item.summary) lines.push(`    Summary: ${item.summary}`);
    lines.push(`    URL: ${item.url}`);
    return lines.join('\n');
  }).join('\n\n');

  const user = `THE TOPIC YOU'RE RESEARCHING:
  Title: ${threadTitle}
${threadSignificance.length > 0 ? `  Significance assessment from organizers: ${threadSignificance.join(' | ')}` : ''}

THE SOURCE ITEMS (${items.length} items the pipeline has gathered for this thread):

${itemBlocks}

YOUR TASK:

Read every item summary above and produce a research note covering:

1. SYNTHESISED FACTS — what the sources collectively establish as known. Things multiple sources agree on, or things one source asserts that others don't contradict. List the most important facts as concise bullet points.

2. CONTESTED CLAIMS — things sources disagree on, or claims that one source makes that haven't been corroborated. These are the heart of any debate worth running. List as bullet points, naming which source(s) made which claim where relevant.

3. OPEN QUESTIONS — areas of genuine uncertainty. Things nobody knows yet. Things that depend on future events or undisclosed information. These are the questions a debate could productively explore. List as bullet points.

4. TIMELINE — a brief chronological summary of how the story has developed across these items. Group events by date where possible.

5. OVERALL SUMMARY — 3-5 sentences capturing what this thread is actually about, what's at stake, and what makes it discussion-worthy today. Write this as if briefing a colleague who just walked in.

6. CENTRAL ITEM IDs — pick the 2-4 source items you considered MOST central to your synthesis (the ones a reader would learn the most from), in order of importance. Use the exact ID from the items above.

This research note will be your reference when you pick the cast next, and (later) when you build the debate agenda. Be thorough but concise. Don't pad. If sources are thin, say so — don't invent depth.

Respond with JSON only:

{
  "synthesisedFacts": ["fact 1", "fact 2", ...],
  "contestedClaims": ["claim 1 (source A vs B)", ...],
  "openQuestions": ["question 1", ...],
  "timeline": [
    { "date": "2026-04-10", "event": "what happened" },
    ...
  ],
  "overallSummary": "<3-5 sentences>",
  "centralItemIds": ["<item id>", ...]
}`;

  return { system, user };
}

// --- Parse the moderator response ---

function parseResearchResponse(raw: string): ResearchResult {
  const empty: ResearchResult = {
    synthesisedFacts: [],
    contestedClaims: [],
    openQuestions: [],
    timeline: [],
    overallSummary: '',
    centralItemIds: [],
  };

  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return { ...empty, error: 'No JSON found' };

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    return {
      synthesisedFacts: Array.isArray(parsed.synthesisedFacts)
        ? (parsed.synthesisedFacts as unknown[]).map(String)
        : [],
      contestedClaims: Array.isArray(parsed.contestedClaims)
        ? (parsed.contestedClaims as unknown[]).map(String)
        : [],
      openQuestions: Array.isArray(parsed.openQuestions)
        ? (parsed.openQuestions as unknown[]).map(String)
        : [],
      timeline: Array.isArray(parsed.timeline)
        ? (parsed.timeline as Array<Record<string, unknown>>).map(t => ({
            date: t.date ? String(t.date) : null,
            event: t.event ? String(t.event) : '',
          }))
        : [],
      overallSummary: typeof parsed.overallSummary === 'string' ? parsed.overallSummary : '',
      centralItemIds: Array.isArray(parsed.centralItemIds)
        ? (parsed.centralItemIds as unknown[]).map(String)
        : [],
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Main entry point ---

/** Run light research: the moderator synthesises the source items
 *  attached to the chosen thread into a research note. Used as
 *  context for cast selection in Stage 5b. */
export async function researchTopicLight(
  threadTitle: string,
  threadSignificance: string[],
  items: ResearchItem[],
  category: string,
  moderatorModel: PoolModel,
): Promise<ResearchResult> {
  if (items.length === 0) {
    return {
      synthesisedFacts: [],
      contestedClaims: [],
      openQuestions: [],
      timeline: [],
      overallSummary: 'No source items attached to this thread.',
      centralItemIds: [],
      error: 'Empty item list — nothing to research',
    };
  }

  console.log(`[RESEARCH] Moderator ${moderatorModel.displayName} researching "${threadTitle}" (${items.length} items)`);

  const { system, user } = buildResearchPrompt(
    threadTitle,
    threadSignificance,
    items,
    category,
    moderatorModel,
  );

  try {
    const raw = await callPoolModel(moderatorModel, system, user, 4000);
    const parsed = parseResearchResponse(raw);

    console.log(`[RESEARCH] ${moderatorModel.displayName}: ${parsed.synthesisedFacts.length} facts, ${parsed.contestedClaims.length} contested, ${parsed.openQuestions.length} open questions`);

    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[RESEARCH] ${moderatorModel.displayName} failed: ${msg}`);
    return {
      synthesisedFacts: [],
      contestedClaims: [],
      openQuestions: [],
      timeline: [],
      overallSummary: '',
      centralItemIds: [],
      error: msg,
    };
  }
}

// ============================================================================
// Stage 5c-i: Deep Research
// ============================================================================

// --- Types ---

export interface DeepResearchSourceFetch {
  itemId: string;
  url: string;
  title: string;
  sourceName: string;
  /** Full extracted article text. Null if fetch/parse failed. */
  text: string | null;
  wordCount: number;
  fetchError: string | null;
}

/** A web search the moderator decided to run, and what came back. */
export interface DeepResearchWebSearch {
  /** The query the moderator generated */
  query: string;
  /** The reason the moderator gave for running this query */
  reason: string;
  /** Tavily results — each with extracted text */
  results: Array<{
    url: string;
    title: string;
    snippet: string;
    fullText: string | null;
    score: number;
  }>;
  /** Error if the search itself failed (e.g. no API key, rate limit) */
  error: string | null;
}

/** A citation source — either a DB-ingested item or a web URL fetched
 *  during the moderator's web search round. */
export interface DeepResearchCitation {
  /** 'db' for items from forum_items, 'web' for Tavily-fetched URLs */
  type: 'db' | 'web';
  /** The DB item id (when type='db') or the URL (when type='web') */
  ref: string;
}

export interface DeepResearchResult {
  /** The moderator's synthesised key claims, with citation hints */
  keyClaims: Array<{
    claim: string;
    citations: DeepResearchCitation[];
  }>;
  /** Concrete evidence snippets the moderator pulled from sources */
  evidenceSnippets: Array<{
    snippet: string;
    citation: DeepResearchCitation;
    relevance: string;
  }>;
  /** Areas the available sources don't adequately cover, even after
   *  the web search round */
  gapsInCoverage: string[];
  /** A deeper free-text synthesis the moderator wrote (longer than light research) */
  overallSynthesis: string;
  /** Per-source fetch results — kept on the snapshot for the journey UI
   *  so readers can see what DB sources the moderator actually read */
  sourceFetches: DeepResearchSourceFetch[];
  /** Web searches the moderator decided to run after reading DB sources.
   *  Each entry carries the query, the moderator's reason, and the
   *  results. Empty array if web search was skipped (no API key) or
   *  the moderator decided no web research was needed. */
  webSearches: DeepResearchWebSearch[];
  /** How many queries the moderator originally generated (before the
   *  MAX_WEB_QUERIES cap). If this exceeds webSearches.length, the
   *  moderator wanted more queries than we allowed — useful signal
   *  for whether the cap should be raised. */
  webSearchesRequested: number;
  /** The cap value at the time this session ran (so historical data
   *  stays interpretable if the cap changes later) */
  webSearchCap: number;
  /** Raw error if the call failed */
  error?: string;
}

// --- Phase A: query generation prompt ---

function buildQueryGenerationPrompt(
  threadTitle: string,
  threadSignificance: string[],
  fetches: DeepResearchSourceFetch[],
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly Forum session in the ${category.toUpperCase()} category. You've already done a light research pass and picked the cast. Now you're starting the deep research phase, which has TWO rounds:

  Round 1 (NOW): read the database-ingested sources below, identify what's missing or thin, and generate 3-${MAX_WEB_QUERIES} web search queries to fill those gaps.
  Round 2 (NEXT): you'll receive the web search results and produce the full deep synthesis.

This is round 1. Your job is to read carefully and generate EFFECTIVE QUERIES — not to start synthesising claims yet. Save the synthesis for round 2 when you have all the material in hand.`;

  const fetchBlocks = fetches.map((f, i) => {
    const lines = [
      `[${i + 1}] ITEM_ID: ${f.itemId}`,
      `    Source: ${f.sourceName}`,
      `    Title: ${f.title}`,
      `    URL: ${f.url}`,
    ];
    if (f.text) {
      lines.push(`    Word count: ${f.wordCount}`);
      lines.push(``);
      lines.push(`    FULL TEXT:`);
      lines.push(f.text);
    } else {
      lines.push(`    [Could not fetch — ${f.fetchError || 'unknown error'}]`);
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const successCount = fetches.filter(f => f.text !== null).length;

  const user = `THE TOPIC:
  Title: ${threadTitle}
${threadSignificance.length > 0 ? `  Significance assessment: ${threadSignificance.join(' | ')}` : ''}

DATABASE SOURCES (${successCount} of ${fetches.length} fetched successfully):

${fetchBlocks}

YOUR TASK:

Read every available source above carefully. Then identify what's MISSING — perspectives, data, criticism, context, or counterpoints that the database sources don't cover but that would matter to a substantive debate on this topic.

Generate 3-${MAX_WEB_QUERIES} web search queries that would fill those gaps. Good queries are SPECIFIC — not "AI safety" but "Apollo Research scheming methodology criticism". Aim for queries that would surface:

- Independent third-party analysis of contested claims
- Counterpoints, criticism, or alternative methodology
- Context the press release / official announcement deliberately omitted
- Expert reactions from outside the originating organization
- Related prior work the sources didn't cite
- Regulatory, governance, or policy context if absent
- Comparison perspectives from other labs (e.g. competitor responses)
- Specific evaluation methodologies mentioned but not detailed in the source

Be honest about how many queries you actually need. If the database sources are genuinely comprehensive and the gaps are minor, fewer queries (3-4) is fine. If the topic is thin and you need broad context, use the upper end of the range. Don't generate filler queries — every query should target a specific gap you can name.

Each query needs a REASON — what gap it's filling, what kind of result you're hoping for. The reason gets published in the journey, so be specific.

Respond with JSON only:

{
  "queries": [
    {
      "query": "<the search query string>",
      "reason": "<one sentence: what gap this fills, what you hope to find>"
    }
  ]
}`;

  return { system, user };
}

interface GeneratedQuery {
  query: string;
  reason: string;
}

function parseGeneratedQueries(raw: string): GeneratedQuery[] {
  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return [];

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) return [];

    // No cap here — the caller applies MAX_WEB_QUERIES so it can log
    // whether the moderator wanted more queries than we allowed
    return (parsed.queries as Array<Record<string, unknown>>)
      .map(q => ({
        query: typeof q.query === 'string' ? q.query : '',
        reason: typeof q.reason === 'string' ? q.reason : '',
      }))
      .filter(q => q.query.length > 0);
  } catch {
    return [];
  }
}

// --- Phase C: synthesis prompt (with both DB + web sources) ---

function buildDeepResearchPrompt(
  threadTitle: string,
  threadSignificance: string[],
  fetches: DeepResearchSourceFetch[],
  webSearches: DeepResearchWebSearch[],
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly Forum session in the ${category.toUpperCase()} category. You're now in round 2 of deep research. You've already read the database-ingested sources and run a round of web searches to fill the gaps. Now you produce the final synthesis.

The agenda you build next will draw directly from this synthesis, so be thorough. You have two source pools:

1. DATABASE SOURCES — items the pipeline ingested from RSS/APIs and you read in full
2. WEB SEARCH RESULTS — pages your earlier query round surfaced, with extracted text

Treat them as a unified body of research. Cite which source each claim comes from using the citation format below.

You are NOT picking cast (already done), NOT building the agenda (next step), NOT taking a stance. You are reading and synthesising at depth.`;

  const dbBlocks = fetches.map((f, i) => {
    const lines = [
      `[DB ${i + 1}] DB_ITEM_ID: ${f.itemId}`,
      `    Source: ${f.sourceName}`,
      `    Title: ${f.title}`,
      `    URL: ${f.url}`,
    ];
    if (f.text) {
      lines.push(`    Word count: ${f.wordCount}`);
      lines.push(``);
      lines.push(`    FULL TEXT:`);
      lines.push(f.text);
    } else {
      lines.push(`    [Could not fetch — ${f.fetchError || 'unknown error'}]`);
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const webBlocks = webSearches.map((ws, qi) => {
    if (ws.error) {
      return `[WEB QUERY ${qi + 1}] "${ws.query}"\n    Reason: ${ws.reason}\n    [Search failed: ${ws.error}]`;
    }
    if (ws.results.length === 0) {
      return `[WEB QUERY ${qi + 1}] "${ws.query}"\n    Reason: ${ws.reason}\n    [No results returned]`;
    }
    const queryHeader = `[WEB QUERY ${qi + 1}] "${ws.query}"\n    Reason: ${ws.reason}`;
    const resultBlocks = ws.results.map((r, ri) => {
      const lines = [
        `  [WEB ${qi + 1}.${ri + 1}] WEB_URL: ${r.url}`,
        `      Title: ${r.title}`,
        `      Relevance score: ${r.score.toFixed(2)}`,
      ];
      if (r.fullText) {
        lines.push(`      EXTRACTED CONTENT:`);
        lines.push(r.fullText.split('\n').map(l => '      ' + l).join('\n'));
      } else {
        lines.push(`      Snippet only: ${r.snippet}`);
      }
      return lines.join('\n');
    }).join('\n\n');
    return `${queryHeader}\n${resultBlocks}`;
  }).join('\n\n===\n\n');

  const dbSuccessCount = fetches.filter(f => f.text !== null).length;
  const webResultCount = webSearches.reduce((sum, ws) => sum + ws.results.length, 0);

  const user = `THE TOPIC:
  Title: ${threadTitle}
${threadSignificance.length > 0 ? `  Significance: ${threadSignificance.join(' | ')}` : ''}

DATABASE SOURCES (${dbSuccessCount} of ${fetches.length} fetched):

${dbBlocks}

${webSearches.length > 0 ? `WEB SEARCH RESULTS (${webResultCount} pages across ${webSearches.length} queries):

${webBlocks}` : 'NO WEB SEARCH WAS RUN.'}

YOUR TASK:

Produce a deep research note covering:

1. KEY CLAIMS — the substantive assertions across both source pools. For each claim, list its citations using this format:
   - DB source: { "type": "db", "ref": "<DB_ITEM_ID from above>" }
   - Web source: { "type": "web", "ref": "<WEB_URL from above>" }
   A single claim can have multiple citations spanning both pools. Be specific — vague claims are useless.

2. EVIDENCE SNIPPETS — short quotes or close paraphrases you might bring up in the debate. Each has ONE citation (the most direct source). Aim for 5-12 across both pools.

3. GAPS IN COVERAGE — what's STILL missing after the web search round. If the web search filled most gaps, the list should be short. If it didn't, name what's still uncovered.

4. OVERALL SYNTHESIS — 4-8 sentences capturing what the sources collectively establish, where they conflict, and where they leave open questions. Substantively richer than your light research note. If the web round revealed counterpoints to the official story, surface them.

If a source failed to fetch, don't invent claims from it.

Respond with JSON only:

{
  "keyClaims": [
    {
      "claim": "<the assertion>",
      "citations": [
        { "type": "db", "ref": "<DB_ITEM_ID>" },
        { "type": "web", "ref": "<WEB_URL>" }
      ]
    }
  ],
  "evidenceSnippets": [
    {
      "snippet": "<short quote or paraphrase>",
      "citation": { "type": "db" | "web", "ref": "<id or url>" },
      "relevance": "<why this matters>"
    }
  ],
  "gapsInCoverage": ["<gap 1>", "<gap 2>"],
  "overallSynthesis": "<4-8 sentences>"
}`;

  return { system, user };
}

// --- Parse the deep research response ---

function parseDeepResearchResponse(raw: string): Omit<DeepResearchResult, 'sourceFetches' | 'webSearches' | 'webSearchesRequested' | 'webSearchCap'> {
  const empty: Omit<DeepResearchResult, 'sourceFetches' | 'webSearches' | 'webSearchesRequested' | 'webSearchCap'> = {
    keyClaims: [],
    evidenceSnippets: [],
    gapsInCoverage: [],
    overallSynthesis: '',
  };

  function parseCitation(c: unknown): DeepResearchCitation | null {
    if (!c || typeof c !== 'object') return null;
    const obj = c as Record<string, unknown>;
    const type = obj.type === 'web' ? 'web' : obj.type === 'db' ? 'db' : null;
    const ref = typeof obj.ref === 'string' ? obj.ref : null;
    if (!type || !ref) return null;
    return { type, ref };
  }

  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      console.warn(`[DEEP-RESEARCH] No JSON found in response. Length=${raw.length}. First 500 chars:`);
      console.warn(raw.slice(0, 500));
      return { ...empty, error: `No JSON found (response length: ${raw.length})` };
    }

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    return {
      keyClaims: Array.isArray(parsed.keyClaims)
        ? (parsed.keyClaims as Array<Record<string, unknown>>).map(c => ({
            claim: typeof c.claim === 'string' ? c.claim : '',
            citations: Array.isArray(c.citations)
              ? (c.citations as unknown[]).map(parseCitation).filter((x): x is DeepResearchCitation => x !== null)
              : [],
          }))
        : [],
      evidenceSnippets: Array.isArray(parsed.evidenceSnippets)
        ? (parsed.evidenceSnippets as Array<Record<string, unknown>>).map(s => {
            const cit = parseCitation(s.citation);
            return {
              snippet: typeof s.snippet === 'string' ? s.snippet : '',
              citation: cit || { type: 'db' as const, ref: '' },
              relevance: typeof s.relevance === 'string' ? s.relevance : '',
            };
          })
        : [],
      gapsInCoverage: Array.isArray(parsed.gapsInCoverage)
        ? (parsed.gapsInCoverage as unknown[]).map(String)
        : [],
      overallSynthesis: typeof parsed.overallSynthesis === 'string' ? parsed.overallSynthesis : '',
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Main entry point: deep research (two-phase) ---

/** Run two-phase deep research:
 *
 *   Phase A — fetch DB sources via readability, moderator reads them,
 *             generates 3-5 web search queries to fill identified gaps
 *   Phase B — system runs queries via Tavily
 *   Phase C — moderator synthesises with both DB sources AND web results
 *
 *  If the Tavily key is missing, Phase A and B are skipped entirely
 *  and the function falls back to single-call synthesis on DB sources
 *  only — same as the pre-Phase-2.5 behaviour. */
export async function researchTopicDeep(
  threadTitle: string,
  threadSignificance: string[],
  itemsToFetch: ResearchItem[],
  category: string,
  moderatorModel: PoolModel,
): Promise<DeepResearchResult> {
  if (itemsToFetch.length === 0) {
    return {
      keyClaims: [],
      evidenceSnippets: [],
      gapsInCoverage: [],
      overallSynthesis: 'No source items provided for deep research.',
      sourceFetches: [],
      webSearches: [],
      webSearchesRequested: 0,
      webSearchCap: MAX_WEB_QUERIES,
      error: 'Empty item list',
    };
  }

  console.log(`[DEEP-RESEARCH] Fetching ${itemsToFetch.length} DB sources via readability...`);

  // Fetch all DB items in parallel
  const articles: ReadableArticle[] = await fetchReadableBatch(
    itemsToFetch.map(i => i.url),
  );

  const sourceFetches: DeepResearchSourceFetch[] = itemsToFetch.map((item, i) => {
    const article = articles[i];
    return {
      itemId: item.id,
      url: item.url,
      title: item.title,
      sourceName: item.sourceName,
      text: article.text,
      wordCount: article.wordCount,
      fetchError: article.error,
    };
  });

  const successCount = sourceFetches.filter(f => f.text !== null).length;
  const totalWords = sourceFetches.reduce((sum, f) => sum + f.wordCount, 0);
  console.log(`[DEEP-RESEARCH] Fetched ${successCount}/${itemsToFetch.length} DB sources (${totalWords} total words)`);

  if (successCount === 0) {
    return {
      keyClaims: [],
      evidenceSnippets: [],
      gapsInCoverage: [],
      overallSynthesis: 'No sources could be fetched — readability parser returned errors for every URL.',
      sourceFetches,
      webSearches: [],
      webSearchesRequested: 0,
      webSearchCap: MAX_WEB_QUERIES,
      error: 'All source fetches failed',
    };
  }

  // === Phase A: generate web search queries ===
  // Skip entirely if no Tavily key — fall through to synthesis with DB only
  const hasTavily = !!process.env.TAVILY_API_KEY;
  let webSearches: DeepResearchWebSearch[] = [];
  let webSearchesRequested = 0;

  if (hasTavily) {
    console.log(`[DEEP-RESEARCH] Phase A: ${moderatorModel.displayName} generating web queries (cap ${MAX_WEB_QUERIES})...`);
    try {
      const queryPrompt = buildQueryGenerationPrompt(
        threadTitle,
        threadSignificance,
        sourceFetches,
        category,
        moderatorModel,
      );
      // 4000 tokens — the query generation output is small (3-8 queries)
      // but Gemini 2.5 Pro eats thinking tokens from the same budget.
      const queryRaw = await callPoolModel(moderatorModel, queryPrompt.system, queryPrompt.user, 4000);
      const generatedQueries = parseGeneratedQueries(queryRaw);
      webSearchesRequested = generatedQueries.length;

      // Apply the cap. Log clearly when the moderator wanted more than
      // we allowed — this is the signal for whether to raise the cap.
      const queriesToRun = generatedQueries.slice(0, MAX_WEB_QUERIES);
      if (generatedQueries.length > MAX_WEB_QUERIES) {
        console.warn(
          `[DEEP-RESEARCH] Moderator generated ${generatedQueries.length} queries — capped at ${MAX_WEB_QUERIES}. Consider raising MAX_WEB_QUERIES if this happens often.`,
        );
      } else {
        console.log(`[DEEP-RESEARCH] Generated ${generatedQueries.length} queries (within cap)`);
      }

      // === Phase B: run queries via Tavily ===
      if (queriesToRun.length > 0) {
        console.log(`[DEEP-RESEARCH] Phase B: running web searches...`);
        const searchResponses = await searchWebBatch(
          queriesToRun.map(q => q.query),
        );

        webSearches = queriesToRun.map((gq, i) => {
          const sr: WebSearchResponse = searchResponses[i];
          return {
            query: gq.query,
            reason: gq.reason,
            results: sr.results,
            error: sr.error,
          };
        });

        const totalWebResults = webSearches.reduce((s, ws) => s + ws.results.length, 0);
        console.log(`[DEEP-RESEARCH] Web round complete: ${totalWebResults} results across ${webSearches.length} queries`);
      }
    } catch (err) {
      console.warn(`[DEEP-RESEARCH] Web research round failed: ${err instanceof Error ? err.message : 'unknown'} — proceeding with DB sources only`);
    }
  } else {
    console.log(`[DEEP-RESEARCH] No TAVILY_API_KEY — skipping web research, synthesising from DB sources only`);
  }

  // === Phase C: final synthesis with both source pools ===
  console.log(`[DEEP-RESEARCH] Phase C: ${moderatorModel.displayName} synthesising final research note...`);

  const { system, user } = buildDeepResearchPrompt(
    threadTitle,
    threadSignificance,
    sourceFetches,
    webSearches,
    category,
    moderatorModel,
  );

  try {
    // 16k output budget — the synthesis prompt asks for many claims,
    // snippets, gaps, and a multi-sentence synthesis. With both DB +
    // web sources in the input, the response can be substantial.
    const raw = await callPoolModel(moderatorModel, system, user, 16000);
    console.log(`[DEEP-RESEARCH] Raw response length: ${raw.length} chars`);
    const parsed = parseDeepResearchResponse(raw);

    console.log(`[DEEP-RESEARCH] ${moderatorModel.displayName}: ${parsed.keyClaims.length} key claims, ${parsed.evidenceSnippets.length} evidence snippets, ${parsed.gapsInCoverage.length} gaps`);

    return {
      ...parsed,
      sourceFetches,
      webSearches,
      webSearchesRequested,
      webSearchCap: MAX_WEB_QUERIES,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[DEEP-RESEARCH] ${moderatorModel.displayName} failed: ${msg}`);
    return {
      keyClaims: [],
      evidenceSnippets: [],
      gapsInCoverage: [],
      overallSynthesis: '',
      sourceFetches,
      webSearches,
      webSearchesRequested,
      webSearchCap: MAX_WEB_QUERIES,
      error: msg,
    };
  }
}
