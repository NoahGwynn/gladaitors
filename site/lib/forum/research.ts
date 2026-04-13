// ============================================================================
// dAIly Forum — Stage 5a: Light Research
// ============================================================================
// The moderator reads the source items attached to the chosen thread and
// produces a synthesised research note. This is "light" research — it
// works from the title + summary + url + source name we already have
// stored on each forum_items row from RSS ingestion. Full article
// fetching via readability parser is deferred to Stage 5c (deep
// research), where it pairs naturally with agenda building.
//
// Why light research before cast selection:
// The pool already declared their stances during Stage 3 broadcast based
// only on the thread title + significance from organizers. The moderator
// at Stage 5b will pick cast based on those stances. Without ANY
// research, the moderator's view of the topic is the same thin context
// the pool had — meaning cast picks are surface-level. The light
// research here gives the moderator a more nuanced view than what the
// pool worked from, so cast picks (and the reasoning behind them) are
// more substantive.
//
// One LLM call to the moderator, structured JSON output.
// ============================================================================

import { callPoolModel, type PoolModel } from './model-pool';
import { buildIdentityAnchor } from './broadcast';

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
