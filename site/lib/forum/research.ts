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

export interface DeepResearchResult {
  /** The moderator's synthesised key claims, with citation hints */
  keyClaims: Array<{
    claim: string;
    citationItemIds: string[];
  }>;
  /** Concrete evidence snippets the moderator pulled from the sources */
  evidenceSnippets: Array<{
    snippet: string;
    sourceItemId: string;
    relevance: string;
  }>;
  /** Areas the available sources don't adequately cover */
  gapsInCoverage: string[];
  /** A deeper free-text synthesis the moderator wrote (longer than light research) */
  overallSynthesis: string;
  /** Per-source fetch results — kept on the snapshot for the journey UI
   *  so readers can see what the moderator actually read */
  sourceFetches: DeepResearchSourceFetch[];
  /** Raw error if the call failed */
  error?: string;
}

// --- Build the deep research prompt ---

function buildDeepResearchPrompt(
  threadTitle: string,
  threadSignificance: string[],
  fetches: DeepResearchSourceFetch[],
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly Forum session in the ${category.toUpperCase()} category. You've already done a light research pass and picked the cast. Now you're doing the DEEP read — actually digesting the full article text from the most central sources before you build the debate agenda.

This is your last chance to update your understanding before the debate runs. The agenda you build next will draw directly from this synthesis, so be thorough. Your job here is to:

1. Read every full article text below carefully
2. Identify the KEY CLAIMS — the substantive assertions the sources make, with which item(s) support each one
3. Pull out concrete EVIDENCE SNIPPETS — short verbatim quotes or close paraphrases that you might want to bring up in the debate
4. Note GAPS — things that aren't covered by the sources but matter to the discussion
5. Write a deeper SYNTHESIS — longer and more substantive than the light research note

You are NOT picking cast (already done), NOT building the agenda (next step), NOT taking a stance. You are reading and synthesising at depth.`;

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

  const user = `THE TOPIC YOU'RE RESEARCHING IN DEPTH:
  Title: ${threadTitle}
${threadSignificance.length > 0 ? `  Significance assessment: ${threadSignificance.join(' | ')}` : ''}

THE SOURCES (${successCount} of ${fetches.length} fetched successfully):

${fetchBlocks}

YOUR TASK:

Produce a deep research note covering:

1. KEY CLAIMS — the substantive assertions the sources make. For each claim, note which item(s) support it via their ITEM_ID. Be specific. "The methodology has limitations" is too vague; "The sample of 50 prompts is too small to generalize across model scales (Item A)" is useful.

2. EVIDENCE SNIPPETS — short quotes or close paraphrases (1-2 sentences each) you might bring up during the debate. For each, name the source item and explain the relevance. Aim for 5-10 snippets covering the most debate-worthy ground.

3. GAPS IN COVERAGE — things that matter to this discussion but aren't covered by the sources. Be honest. If the source material doesn't address X, say so.

4. OVERALL SYNTHESIS — 4-6 sentences capturing what the sources collectively establish, where they conflict, and where they leave open questions. Substantively richer than your light research note.

If a source failed to fetch (marked above), don't try to invent claims from it. Work only from what you actually read.

Respond with JSON only:

{
  "keyClaims": [
    { "claim": "<the assertion>", "citationItemIds": ["<item id>", ...] }
  ],
  "evidenceSnippets": [
    { "snippet": "<short quote or paraphrase>", "sourceItemId": "<item id>", "relevance": "<why this matters>" }
  ],
  "gapsInCoverage": ["<gap 1>", "<gap 2>"],
  "overallSynthesis": "<4-6 sentences>"
}`;

  return { system, user };
}

// --- Parse the deep research response ---

function parseDeepResearchResponse(raw: string): Omit<DeepResearchResult, 'sourceFetches'> {
  const empty: Omit<DeepResearchResult, 'sourceFetches'> = {
    keyClaims: [],
    evidenceSnippets: [],
    gapsInCoverage: [],
    overallSynthesis: '',
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
      keyClaims: Array.isArray(parsed.keyClaims)
        ? (parsed.keyClaims as Array<Record<string, unknown>>).map(c => ({
            claim: typeof c.claim === 'string' ? c.claim : '',
            citationItemIds: Array.isArray(c.citationItemIds)
              ? (c.citationItemIds as unknown[]).map(String)
              : [],
          }))
        : [],
      evidenceSnippets: Array.isArray(parsed.evidenceSnippets)
        ? (parsed.evidenceSnippets as Array<Record<string, unknown>>).map(s => ({
            snippet: typeof s.snippet === 'string' ? s.snippet : '',
            sourceItemId: typeof s.sourceItemId === 'string' ? s.sourceItemId : '',
            relevance: typeof s.relevance === 'string' ? s.relevance : '',
          }))
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

// --- Main entry point: deep research ---

/** Run deep research: fetch the full article text for the most central
 *  items via the readability parser, then have the moderator synthesise
 *  the substance into a deep research note. Used after cast selection
 *  and before agenda build. */
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
      error: 'Empty item list',
    };
  }

  console.log(`[DEEP-RESEARCH] Fetching ${itemsToFetch.length} sources via readability...`);

  // Fetch all items in parallel
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
  console.log(`[DEEP-RESEARCH] Fetched ${successCount}/${itemsToFetch.length} sources (${totalWords} total words)`);

  if (successCount === 0) {
    return {
      keyClaims: [],
      evidenceSnippets: [],
      gapsInCoverage: [],
      overallSynthesis: 'No sources could be fetched — readability parser returned errors for every URL.',
      sourceFetches,
      error: 'All source fetches failed',
    };
  }

  console.log(`[DEEP-RESEARCH] ${moderatorModel.displayName} synthesising...`);

  const { system, user } = buildDeepResearchPrompt(
    threadTitle,
    threadSignificance,
    sourceFetches,
    category,
    moderatorModel,
  );

  try {
    // Bigger token budget for the deep call — we're sending full article
    // text in and expecting a richer synthesis out.
    const raw = await callPoolModel(moderatorModel, system, user, 8000);
    const parsed = parseDeepResearchResponse(raw);

    console.log(`[DEEP-RESEARCH] ${moderatorModel.displayName}: ${parsed.keyClaims.length} key claims, ${parsed.evidenceSnippets.length} evidence snippets, ${parsed.gapsInCoverage.length} gaps`);

    return {
      ...parsed,
      sourceFetches,
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
      error: msg,
    };
  }
}
