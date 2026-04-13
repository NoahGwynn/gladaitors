// ============================================================================
// dAIly Forum — Stage 5c-ii: Agenda Build
// ============================================================================
// The moderator builds a structured debate playbook around the topic,
// the cast, the deep research, and the pre-loaded tagged memory of
// each cast member's past statements on related topics.
//
// The agenda is NOT a strict script. It's a playbook the Stage 6
// debate runtime executes against. The moderator at runtime can
// follow the planned flow, deviate to follow tangents, surface memory
// contradictions, give opponents a chance to respond, etc. The
// agenda gives them grounding; the runtime gives them flexibility.
//
// Three internal steps:
//   1. Tag the topic — Sonnet call to assign 1-3 tags from the
//      category taxonomy (used to query memory)
//   2. Pre-load memory — for each cast member, query forum_utterances
//      by both model_id (exact) and model_family (cross-version) on
//      the topic tags, returning relevant past statements
//   3. Build the agenda — moderator LLM call with topic, light + deep
//      research, cast, and pre-loaded memory hits per cast member
//
// On cold start the memory pre-load returns empty hits — that's
// expected and the moderator builds the agenda without past-statement
// references. As sessions accumulate, this gets richer over time.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { callPoolModel, type PoolModel } from './model-pool';
import { buildIdentityAnchor } from './broadcast';
import { getTaxonomy, filterValidTags } from './tag-taxonomy';
import { queryMemory, type MemoryHit } from './memory-query';
import type { ResearchResult, DeepResearchResult } from './research';
import type { CastParticipant } from './cast-selection';

// --- Types ---

export interface AgendaSegment {
  /** Short label, e.g. "opening positions" | "contested: methodology" */
  name: string;
  /** Headline question the moderator asks at the top of this segment */
  mainQuestion: string;
  /** Sub-prompts the moderator can use as needed during the segment */
  subQuestions: string[];
  /** Seat numbers in the order the moderator should ask them */
  participantsToAsk: number[];
  /** Runtime guidance — why this segment matters, what good engagement
   *  looks like, what to press on if answers are thin */
  whyItMatters: string;
  /** Soft duration hint */
  expectedDuration: 'short' | 'medium' | 'long';
  /** Pre-loaded research references the moderator can draw from in
   *  this segment without needing to look them up at runtime */
  relatedResearch: Array<{
    facts: string;
    sourceItemIds: string[];
  }>;
  /** Pre-loaded past statements from cast members on related topics —
   *  the moderator already has these in context, ready to surface as
   *  contradictions or echoes during the segment */
  relatedMemory: Array<{
    participantSeat: number;
    pastStatement: string;
    sessionId: string;
    sessionDate: string;
    relevance: string;
  }>;
}

export interface Agenda {
  /** What the moderator opens the session with — 2-3 sentences */
  sessionFraming: string;
  /** 3-5 high-level goals for the session */
  goals: string[];
  /** The structured plan, walked in order at runtime */
  segments: AgendaSegment[];
  /** Optional segments to use if time permits or if a tangent points there */
  optionalDeepening: AgendaSegment[];
  /** What the moderator's planned closing synthesis frames */
  closingFrame: string;
}

export interface AgendaBuildResult extends Agenda {
  /** Tags assigned to the topic (used for memory queries) */
  topicTags: string[];
  /** Per-cast-member memory pre-load — exact + family hits combined,
   *  keyed by seat number for journey display */
  memoryPreload: Array<{
    seat: number;
    modelId: string;
    modelFamily: string;
    exactHits: MemoryHit[];
    familyHits: MemoryHit[];
  }>;
  error?: string;
}

// --- Step 1: tag the topic ---

/** Use Sonnet to assign 1-3 topic tags from the category taxonomy.
 *  Same approach as utterance tagging — tags need to align with the
 *  taxonomy used at storage time so memory queries work. */
async function tagTopic(
  topicTitle: string,
  topicSummary: string,
  category: string,
): Promise<string[]> {
  const taxonomy = getTaxonomy(category);

  const prompt = `You are a topic classifier for the dAIly Forum. A topic has been chosen for today's ${category.toUpperCase()} category session. Assign 1-3 tags from the fixed taxonomy below that best describe what the topic is about. These tags will be used to query past debate statements for cross-session continuity.

TAXONOMY (use only these exact tags):
${taxonomy.map(t => `- ${t}`).join('\n')}

TOPIC TITLE: ${topicTitle}

${topicSummary ? `TOPIC SUMMARY: ${topicSummary}` : ''}

Pick 1-3 tags. Be specific — only pick tags that genuinely describe the topic's substance. Use the exact tag strings.

Respond with JSON only:
{ "tags": ["tag1", "tag2"] }`;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    let raw = text.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return [];

    const parsed = JSON.parse(raw.slice(start, end + 1)) as { tags?: unknown };
    if (!Array.isArray(parsed.tags)) return [];

    const proposed = (parsed.tags as unknown[]).map(String);
    return filterValidTags(category, proposed).slice(0, 3);
  } catch (err) {
    console.warn(`[AGENDA] Topic tagging failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return [];
  }
}

// --- Step 2: pre-load memory for each cast member ---

interface MemoryPreloadEntry {
  seat: number;
  modelId: string;
  modelFamily: string;
  exactHits: MemoryHit[];
  familyHits: MemoryHit[];
}

/** For each cast member, query forum_utterances both by exact model_id
 *  (their own past statements) and by model_family (cross-version, so
 *  Claude Opus 4.6 sees what Claude Opus 4.5 said). Returns hits per
 *  seat. Empty arrays on cold start are expected. */
async function preloadMemoryForCast(
  cast: CastParticipant[],
  topicTags: string[],
  category: string,
  excludeSessionId: string,
): Promise<MemoryPreloadEntry[]> {
  if (topicTags.length === 0 || cast.length === 0) {
    return cast.map(c => ({
      seat: c.seat,
      modelId: c.modelId,
      modelFamily: '',
      exactHits: [],
      familyHits: [],
    }));
  }

  const results: MemoryPreloadEntry[] = [];

  for (const member of cast) {
    // Exact model_id query — what THIS exact model has said before
    const exactHits = await queryMemory({
      modelId: member.modelId,
      tags: topicTags,
      category,
      excludeSessionIds: [excludeSessionId],
      limit: 3,
    });

    // Family query — what other versions in the same lineage have said.
    // We need the family from MODEL_POOL since cast doesn't carry it.
    // The provider field on cast holds the provider name; we use the
    // first cast member's provider as a fallback, but really we should
    // resolve via MODEL_POOL.
    // (modelFamily is needed for cross-version queries — looked up below)
    const { MODEL_POOL } = await import('./model-pool');
    const poolModel = MODEL_POOL.find(m => m.id === member.modelId);
    const family = poolModel?.family || '';

    let familyHits: MemoryHit[] = [];
    if (family) {
      const allFamilyHits = await queryMemory({
        modelFamily: family,
        tags: topicTags,
        category,
        excludeSessionIds: [excludeSessionId],
        limit: 5,
      });
      // Filter out the exact-id hits (already in exactHits) so we
      // only show genuinely cross-version statements
      familyHits = allFamilyHits.filter(h => h.modelId !== member.modelId).slice(0, 3);
    }

    results.push({
      seat: member.seat,
      modelId: member.modelId,
      modelFamily: family,
      exactHits,
      familyHits,
    });
  }

  const totalExact = results.reduce((s, r) => s + r.exactHits.length, 0);
  const totalFamily = results.reduce((s, r) => s + r.familyHits.length, 0);
  console.log(`[AGENDA] Memory pre-load: ${totalExact} exact + ${totalFamily} family hits across ${cast.length} cast members`);

  return results;
}

// --- Step 3: build the agenda prompt ---

function buildAgendaPrompt(
  topicTitle: string,
  topicSignificance: string[],
  lightResearch: ResearchResult,
  deepResearch: DeepResearchResult,
  cast: CastParticipant[],
  sessionType: 'debate' | 'fireside_chat',
  memoryPreload: MemoryPreloadEntry[],
  category: string,
  moderatorModel: PoolModel,
): { system: string; user: string } {
  const sessionTypeLabel = sessionType === 'fireside_chat' ? 'fireside chat' : 'debate';

  const system = `${buildIdentityAnchor(moderatorModel)}

You are the moderator of today's dAIly Forum session in the ${category.toUpperCase()} category. You've completed your research (light + deep, including web augmentation) and picked the cast for a ${sessionTypeLabel}. Now you build the agenda — the structured playbook you'll execute against during the session.

The agenda is NOT a strict script. It's a planned flow that the runtime will follow by default but can deviate from when warranted. You will be able to: ask the planned questions in order, follow up on interesting answers, give opponents a chance to respond to a point, surface a memory contradiction from a participant's history, follow a productive tangent, pull back to the plan when a tangent isn't going anywhere, and close when coverage is sufficient.

Your job here is to produce the SHAPE of that flow. Be deliberate. The agenda is published as part of the session record alongside the actual debate, so the audience can see what you planned versus what you actually did.`;

  const dbResearchBlock = lightResearch.overallSummary
    ? `LIGHT RESEARCH (your earlier first read of the source items):
${lightResearch.overallSummary}

Synthesised facts:
${lightResearch.synthesisedFacts.map(f => `  - ${f}`).join('\n')}

Contested claims:
${lightResearch.contestedClaims.map(c => `  - ${c}`).join('\n')}

Open questions:
${lightResearch.openQuestions.map(q => `  - ${q}`).join('\n')}`
    : '(no light research available)';

  const deepResearchBlock = deepResearch.overallSynthesis
    ? `DEEP RESEARCH (your full read of source articles + web augmentation):
${deepResearch.overallSynthesis}

Key claims (with citation refs):
${deepResearch.keyClaims.map(c => {
      const cits = c.citations.map(x => x.type === 'db' ? `[DB ${x.ref.slice(0, 8)}]` : `[WEB ${x.ref}]`).join(' ');
      return `  - ${c.claim} ${cits}`;
    }).join('\n')}

Evidence snippets you might bring up:
${deepResearch.evidenceSnippets.map(s => {
      const cit = s.citation.type === 'db' ? `[DB ${s.citation.ref.slice(0, 8)}]` : `[WEB ${s.citation.ref}]`;
      return `  - "${s.snippet}" ${cit} — ${s.relevance}`;
    }).join('\n')}

Remaining gaps in coverage:
${deepResearch.gapsInCoverage.map(g => `  - ${g}`).join('\n')}

DB sources you read in full:
${deepResearch.sourceFetches.filter(f => f.text).map(f => `  [DB ${f.itemId.slice(0, 8)}] ${f.title} (${f.sourceName})`).join('\n')}

Web sources from your search round:
${deepResearch.webSearches.flatMap(ws => ws.results.map(r => `  [WEB ${r.url}] ${r.title}`)).slice(0, 15).join('\n')}`
    : '(no deep research available)';

  const castBlock = cast.map(c => {
    return `SEAT ${c.seat}: ${c.modelName} (${c.provider}, ${c.region})
  Conflict score: ${c.conflictScore}/100
  Stance: ${c.stance}
  Why this seat: ${c.reasoning}`;
  }).join('\n\n');

  const memoryBlock = memoryPreload.map(m => {
    const lines = [`SEAT ${m.seat} — ${m.modelId} (family: ${m.modelFamily || 'unknown'}):`];
    if (m.exactHits.length === 0 && m.familyHits.length === 0) {
      lines.push('  (no past statements found — cold start or no related history)');
    } else {
      if (m.exactHits.length > 0) {
        lines.push('  THIS MODEL\'S OWN PAST STATEMENTS:');
        for (const h of m.exactHits) {
          lines.push(`    - [${h.spokenAt.split('T')[0]} session ${h.sessionId.slice(0, 8)}] ${h.utteranceText.slice(0, 200)}${h.utteranceText.length > 200 ? '...' : ''}`);
        }
      }
      if (m.familyHits.length > 0) {
        lines.push('  CROSS-VERSION (other models in the same family):');
        for (const h of m.familyHits) {
          lines.push(`    - [${h.modelId} on ${h.spokenAt.split('T')[0]}] ${h.utteranceText.slice(0, 200)}${h.utteranceText.length > 200 ? '...' : ''}`);
        }
      }
    }
    return lines.join('\n');
  }).join('\n\n');

  const seatsList = cast.map(c => c.seat).join(', ');

  const user = `THE TOPIC:
  Title: ${topicTitle}
${topicSignificance.length > 0 ? `  Significance: ${topicSignificance.join(' | ')}` : ''}

SESSION TYPE: ${sessionTypeLabel.toUpperCase()}

${dbResearchBlock}

${deepResearchBlock}

YOUR CAST (you do NOT participate; you facilitate):

${castBlock}

PRE-LOADED MEMORY (past statements from these cast members on related topics — for surfacing as contradictions or echoes during the session):

${memoryBlock}

YOUR TASK: build the structured agenda for today's session.

The agenda has these parts:

1. SESSION FRAMING — 2-3 sentences you'll open the session with. Sets the stakes and the question for the audience.

2. GOALS — 3-5 high-level things you want this session to surface. Concrete, not vague. Not "explore the topic" but "test whether the methodology generalises beyond the announced eval set".

3. SEGMENTS — the planned flow, walked in order. Each segment has:
   - name — short label for the runtime to track progress
   - mainQuestion — the headline question you'll ask at the top of this segment
   - subQuestions — 2-4 follow-ups you can use as needed
   - participantsToAsk — array of seat numbers in the order to ask. For "round" segments where every cast member should answer the same question, list every seat (e.g. [${seatsList}]). For "directed" segments where you're targeting one specific voice, list only that seat. For "exchange" segments where seat 1 makes a claim and seat 2 must respond, list both in order.
   - whyItMatters — runtime guidance: what good engagement looks like, what to press on if answers are thin
   - expectedDuration — 'short' | 'medium' | 'long' (rough hint, the runtime can override)
   - relatedResearch — pull facts from your deep research that are directly relevant to this segment. For each, list the source item IDs (DB) or URLs (web) it draws from. The runtime gets these in context for the segment.
   - relatedMemory — if any of the pre-loaded memory hits are directly relevant to this segment, reference them by listing the participantSeat, the past statement, the session id, the date, and your relevance note. If no past memory is relevant, pass an empty array.

4. OPTIONAL DEEPENING — 1-3 segments to use ONLY if a tangent points there or time permits. Same shape as segments. Don't pad — only include if there's a genuine "if interesting we should also explore" angle.

5. CLOSING FRAME — 1-2 sentences for your planned synthesis. The actual close happens at runtime based on what was discussed.

For a ${sessionType === 'fireside_chat' ? 'FIRESIDE CHAT' : 'DEBATE'}: ${sessionType === 'fireside_chat' ? 'every cast member is broadly aligned, so segments should probe the consensus from different angles — what would falsify it, where it might be wrong, what edge cases challenge it. Less adversarial, more collaborative pressure-testing.' : 'cast members have opposing stances, so segments should let opposition emerge naturally. Use round segments for opening positions, directed segments for pressing specific claims, exchange segments where one participant must respond to another\'s argument.'}

Be deliberate. A good agenda has 4-6 main segments, not 10. Each segment should advance the discussion meaningfully. Don't include segments just to fill time.

Respond with JSON only:

{
  "sessionFraming": "<2-3 sentences>",
  "goals": ["<goal 1>", "<goal 2>", ...],
  "segments": [
    {
      "name": "<short label>",
      "mainQuestion": "<headline question>",
      "subQuestions": ["<follow-up 1>", "<follow-up 2>"],
      "participantsToAsk": [1, 2],
      "whyItMatters": "<runtime guidance>",
      "expectedDuration": "short" | "medium" | "long",
      "relatedResearch": [
        { "facts": "<fact you'll draw from>", "sourceItemIds": ["<id or url>"] }
      ],
      "relatedMemory": [
        {
          "participantSeat": 1,
          "pastStatement": "<the past statement>",
          "sessionId": "<session id>",
          "sessionDate": "<YYYY-MM-DD>",
          "relevance": "<why this matters here>"
        }
      ]
    }
  ],
  "optionalDeepening": [ /* same shape, may be empty */ ],
  "closingFrame": "<1-2 sentences>"
}`;

  return { system, user };
}

// --- Parse the agenda response ---

function parseAgendaResponse(raw: string): Agenda | { error: string } {
  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return { error: 'No JSON found' };

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    function parseSegment(s: unknown): AgendaSegment | null {
      if (!s || typeof s !== 'object') return null;
      const obj = s as Record<string, unknown>;
      return {
        name: typeof obj.name === 'string' ? obj.name : '',
        mainQuestion: typeof obj.mainQuestion === 'string' ? obj.mainQuestion : '',
        subQuestions: Array.isArray(obj.subQuestions) ? (obj.subQuestions as unknown[]).map(String) : [],
        participantsToAsk: Array.isArray(obj.participantsToAsk)
          ? (obj.participantsToAsk as unknown[]).map(n => Number(n)).filter(n => !Number.isNaN(n))
          : [],
        whyItMatters: typeof obj.whyItMatters === 'string' ? obj.whyItMatters : '',
        expectedDuration:
          obj.expectedDuration === 'short' || obj.expectedDuration === 'medium' || obj.expectedDuration === 'long'
            ? obj.expectedDuration
            : 'medium',
        relatedResearch: Array.isArray(obj.relatedResearch)
          ? (obj.relatedResearch as Array<Record<string, unknown>>).map(r => ({
              facts: typeof r.facts === 'string' ? r.facts : '',
              sourceItemIds: Array.isArray(r.sourceItemIds) ? (r.sourceItemIds as unknown[]).map(String) : [],
            }))
          : [],
        relatedMemory: Array.isArray(obj.relatedMemory)
          ? (obj.relatedMemory as Array<Record<string, unknown>>).map(m => ({
              participantSeat: typeof m.participantSeat === 'number' ? m.participantSeat : 0,
              pastStatement: typeof m.pastStatement === 'string' ? m.pastStatement : '',
              sessionId: typeof m.sessionId === 'string' ? m.sessionId : '',
              sessionDate: typeof m.sessionDate === 'string' ? m.sessionDate : '',
              relevance: typeof m.relevance === 'string' ? m.relevance : '',
            }))
          : [],
      };
    }

    const segments = Array.isArray(parsed.segments)
      ? (parsed.segments as unknown[]).map(parseSegment).filter((s): s is AgendaSegment => s !== null)
      : [];
    const optionalDeepening = Array.isArray(parsed.optionalDeepening)
      ? (parsed.optionalDeepening as unknown[]).map(parseSegment).filter((s): s is AgendaSegment => s !== null)
      : [];

    return {
      sessionFraming: typeof parsed.sessionFraming === 'string' ? parsed.sessionFraming : '',
      goals: Array.isArray(parsed.goals) ? (parsed.goals as unknown[]).map(String) : [],
      segments,
      optionalDeepening,
      closingFrame: typeof parsed.closingFrame === 'string' ? parsed.closingFrame : '',
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Main entry point ---

/** Build the structured debate agenda. The moderator sees the topic,
 *  light + deep research, the cast, and pre-loaded memory hits per
 *  cast member, then produces the playbook the Stage 6 runtime will
 *  execute against. */
export async function buildAgenda(
  topicTitle: string,
  topicSignificance: string[],
  lightResearch: ResearchResult,
  deepResearch: DeepResearchResult,
  cast: CastParticipant[],
  sessionType: 'debate' | 'fireside_chat',
  moderatorModel: PoolModel,
  category: string,
  sessionId: string,
): Promise<AgendaBuildResult> {
  if (cast.length === 0) {
    return {
      sessionFraming: '',
      goals: [],
      segments: [],
      optionalDeepening: [],
      closingFrame: '',
      topicTags: [],
      memoryPreload: [],
      error: 'No cast — cannot build agenda',
    };
  }

  console.log(`[AGENDA] Building agenda for "${topicTitle.slice(0, 60)}" (${sessionType}, ${cast.length} cast)`);

  // Step 1: tag the topic for memory queries
  const topicSummary = lightResearch.overallSummary || deepResearch.overallSynthesis || '';
  const topicTags = await tagTopic(topicTitle, topicSummary, category);
  console.log(`[AGENDA] Topic tagged: ${topicTags.join(', ') || '(no tags)'}`);

  // Step 2: pre-load memory per cast member
  const memoryPreload = await preloadMemoryForCast(cast, topicTags, category, sessionId);

  // Step 3: build the agenda via moderator LLM call
  console.log(`[AGENDA] ${moderatorModel.displayName} building agenda...`);
  const { system, user } = buildAgendaPrompt(
    topicTitle,
    topicSignificance,
    lightResearch,
    deepResearch,
    cast,
    sessionType,
    memoryPreload,
    category,
    moderatorModel,
  );

  let raw: string;
  try {
    raw = await callPoolModel(moderatorModel, system, user, 6000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[AGENDA] Moderator call failed: ${msg}`);
    return {
      sessionFraming: '',
      goals: [],
      segments: [],
      optionalDeepening: [],
      closingFrame: '',
      topicTags,
      memoryPreload,
      error: msg,
    };
  }

  const parsed = parseAgendaResponse(raw);
  if ('error' in parsed) {
    console.error(`[AGENDA] Parse failed: ${parsed.error}`);
    return {
      sessionFraming: '',
      goals: [],
      segments: [],
      optionalDeepening: [],
      closingFrame: '',
      topicTags,
      memoryPreload,
      error: parsed.error,
    };
  }

  console.log(`[AGENDA] Built: ${parsed.segments.length} segments, ${parsed.optionalDeepening.length} optional, ${parsed.goals.length} goals`);

  return {
    ...parsed,
    topicTags,
    memoryPreload,
  };
}
