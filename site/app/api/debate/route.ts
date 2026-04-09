// ============================================================================
// POST /api/debate — Generate ONE round of a debate (streaming)
// ============================================================================
// The route runs ONLY the round specified by `currentRound`. The frontend
// orchestrates the round-by-round loop, calling this endpoint once per round.
//
// Within a single round, debaters are called sequentially in order. Any
// debater whose argument for this round already exists in `existingArguments`
// is skipped (used by feature #3 — user-as-participant — and by resume).
//
// Each debater is identified by debater_index (0, 1, 2) — their position in
// the debaters array. This allows the same model to appear multiple times
// (e.g., Claude vs Claude).
//
// SSE event types:
//   thinking            — a model is about to respond
//   token               — a chunk of text from the current model
//   argument            — a completed argument (full text + metadata)
//   model_error         — a model failed to respond (round continues)
//   insufficient_tokens — out of tokens; round stops, stream closes
//   round_complete      — this round finished cleanly
//   user_turn_needed    — a human-player slot needs input; round stops, stream closes
//   positions_resolved  — auto-assigned positions are now finalised (round 1 only)
//   error               — unrecoverable error
// ============================================================================

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { createServerSupabase } from '@/lib/supabase-server';
import { findModel, type ModelDefinition } from '@/lib/models';

interface DebaterInput {
  modelId: string;
  position: string;
  /** 'manual' = user typed the position; 'auto' = AI picks its own stance on the first round */
  assignmentMode?: 'manual' | 'auto';
}

interface DebateRequest {
  topic: string;
  debaters: DebaterInput[];
  rounds: number;            // total rounds in the debate (for prompt context)
  currentRound: number;      // the round to run on this call
  context?: string;
  revealIdentities?: boolean;
  existingArguments?: DebateArgument[];
  /** Optional: the debate's ID. Used to persist resolved auto-assigned positions. */
  debateId?: string;
}

interface DebateArgument {
  debater_index: number;
  model_id: string;
  model_name: string;
  round: number;
  content: string;
  refused: boolean;
  refusal_reason?: string;
}

/** Generate unique display names — adds numbering when the same model appears twice.
 *  User slots use "Human" as the base label (not the picker name "Me"), so prompts
 *  and the debate UI never collide with the AI's own "You" self-label.
 */
function getDisplayNames(debaters: DebaterInput[]): string[] {
  const counts: Record<string, number> = {};
  debaters.forEach(d => { counts[d.modelId] = (counts[d.modelId] || 0) + 1; });

  const seen: Record<string, number> = {};
  return debaters.map(d => {
    const model = findModel(d.modelId);
    const base = model?.family === 'user' ? 'Human' : (model?.name || d.modelId);
    if (counts[d.modelId] === 1) return base;
    seen[d.modelId] = (seen[d.modelId] || 0) + 1;
    return `${base} ${seen[d.modelId]}`;
  });
}

function buildSystemPrompt(
  displayName: string,
  position: string,
  topic: string,
  totalRounds: number,
  debaterIndex: number,
  allDebaters: DebaterInput[],
  displayNames: string[],
  revealIdentities: boolean,
  context?: string,
): string {
  const opponents = allDebaters
    .map((d, i) => ({ debater: d, name: displayNames[i], index: i }))
    .filter(o => o.index !== debaterIndex);

  let opponentsSection: string;
  if (revealIdentities) {
    const lines = opponents
      .map(o => `${o.name} argues: "${o.debater.position}"`)
      .join('\n');
    opponentsSection = `YOUR OPPONENTS:\n${lines}`;
  } else {
    const lines = opponents
      .map((o, i) => `Opponent ${i + 1} argues: "${o.debater.position}"`)
      .join('\n');
    opponentsSection = `YOUR OPPONENTS (their identities are hidden from you):\n${lines}`;
  }

  let prompt = `You are ${displayName}, participating in a structured debate.

TOPIC: "${topic}"
YOUR ASSIGNED POSITION: "${position}"

${opponentsSection}

You must argue this position to the best of your ability across ${totalRounds} rounds.
Even if you personally disagree, argue the assigned position persuasively and substantively.

If you genuinely cannot argue this position (e.g., it requires producing harmful content),
say so clearly and explain why. Do not pretend to argue it while undermining it.

=== FORMATTING RULES (read carefully — every argument must follow these) ===

EVERY response must begin with a short bold title on its own line, then a blank line, then
the argument body. The title is part of the response, not separate from it.

TITLE FORMAT
- Wrap in markdown bold: **Like This**
- Maximum six words
- Should capture the core thrust of THIS specific argument, not the overall position
- No quotation marks, no trailing punctuation, no labels like "Round 2:" or "My Argument:"
- Sentence case (capitalise first word and proper nouns only)
- Examples:
  **The cost of being wrong**
  **Consciousness cannot be an illusion**
  **Why scale is not the answer**
  **A simpler path forward**

BODY FORMAT
- 150 to 250 words. Do not pad to reach the upper end — write what is needed and stop.
- Plain prose paragraphs. No bullet lists, no numbered lists, no sub-headings inside the body.
- You MAY use **bold** sparingly (1-3 phrases per response) to emphasise the strongest words
  or claims. Do not bold whole sentences.
- You MAY use *italics* sparingly for genuine emphasis or to introduce a term.
- Do not use blockquotes, code blocks, tables, horizontal rules, or images.
- Do not include section labels like "Argument:", "Rebuttal:", "Conclusion:" — let the prose
  do the structural work.
- Do not start with meta commentary ("I'll argue that...", "In this round I will...",
  "Let me address..."). Open straight into the argument itself.

VOICE
- Write in first person. You are the debater, not a narrator describing the debater.
- Address opponents directly when responding to them, by name if you know it ("Claude argues..."
  or "Opponent 1 claims..."). Quote their phrasing when you want to refute it precisely.
- Be direct, not hedging. "This is wrong because..." not "It might be the case that..."
- Substance over rhetoric. Concrete examples, specific consequences, real-world stakes.
- Avoid filler phrases: "It is important to note that...", "At the end of the day...",
  "In today's world...", "Throughout history..."

REFUSAL HANDLING
- If you genuinely cannot argue this position, refuse clearly in plain prose without a title.
  Begin with "I cannot argue this position" so the system can detect the refusal.
- Do not refuse on stylistic grounds, only on safety/ethics grounds.

=== END FORMATTING RULES ===

Reference and respond to other debaters' arguments when they exist. Build on what came before.
Each round should advance the case, not just restate the previous round's points.`;

  if (context) {
    prompt += `\n\nADDITIONAL RULES FROM THE USER: ${context}`;
  }

  return prompt;
}

/** A single turn in the multi-turn conversation passed to the model. */
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Build a multi-turn message list for one debater's call to the model.
 *
 * The structure is the model's own perspective on the conversation:
 *  - The model's previous arguments are 'assistant' messages.
 *  - Opponent arguments accumulated since the model last spoke are folded into
 *    the next 'user' message, alongside the round instruction.
 *  - The final 'user' message represents the current round being asked for.
 *
 * Successive rounds produce message lists where the previous round's list is
 * a strict prefix — this lets Anthropic's prefix caching (and OpenAI's
 * automatic caching) reuse the cached prefix without us doing anything fancy
 * beyond marking the latest user message with cache_control in streamClaude.
 */
function buildMessages(
  currentRound: number,
  totalRounds: number,
  currentDebaterIndex: number,
  previousArguments: DebateArgument[],
  displayNames: string[],
  revealIdentities: boolean,
): ChatMessage[] {
  // Stable opponent labels — built once per call so the order matches across user messages
  const anonLabels = new Map<number, string>();
  let anonCounter = 0;

  function labelFor(debaterIndex: number): string {
    if (debaterIndex === currentDebaterIndex) return 'You';
    if (revealIdentities) return displayNames[debaterIndex] || `Debater ${debaterIndex + 1}`;
    if (!anonLabels.has(debaterIndex)) {
      anonCounter++;
      anonLabels.set(debaterIndex, `Opponent ${anonCounter}`);
    }
    return anonLabels.get(debaterIndex)!;
  }

  function instructionFor(round: number): string {
    if (round === 1) {
      return 'This is the opening round. State your position clearly and make your strongest opening argument.';
    }
    if (round === totalRounds) {
      return 'This is the final round. Summarise your strongest points and deliver your closing argument.';
    }
    return `Round ${round} of ${totalRounds}. Respond to the previous arguments and advance your case.`;
  }

  function buildUserContent(
    round: number,
    newOpponentArgs: DebateArgument[],
    pendingModeratorNotes: DebateArgument[],
  ): string {
    let text = '';
    if (newOpponentArgs.length > 0) {
      text += 'Other debaters have said:\n';
      for (const arg of newOpponentArgs) {
        const label = labelFor(arg.debater_index);
        if (arg.refused) {
          text += `\n${label} declined to argue their position.\n`;
        } else {
          text += `\n${label}:\n${arg.content}\n`;
        }
      }
      text += '\n';
    }
    if (pendingModeratorNotes.length > 0) {
      text += '=== MODERATOR INTERJECTION ===\n';
      text += 'The moderator has interjected with the following note. You must engage\n';
      text += 'with it directly in your response — acknowledge it, accept or push back\n';
      text += 'on its framing, and let it shape your argument. Do not ignore it.\n\n';
      for (const note of pendingModeratorNotes) {
        text += `"${note.content}"\n\n`;
      }
      text += '=== END MODERATOR INTERJECTION ===\n\n';
      // Override the standard instruction to make the moderator engagement explicit
      text += `Round ${round}. Address the moderator's interjection above directly in your response, then continue advancing your case.`;
      return text;
    }
    text += instructionFor(round);
    return text;
  }

  // Sort by round, then by debater_index within each round.
  // Moderator notes (debater_index = -1) sort first within their round so they
  // appear before any debater args of the same round.
  const sortedArgs = [...previousArguments].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.debater_index - b.debater_index;
  });

  const messages: ChatMessage[] = [];
  let pendingOpponentArgs: DebateArgument[] = [];
  let pendingModeratorNotes: DebateArgument[] = [];

  for (const arg of sortedArgs) {
    // Moderator notes are not from a debater — they're context injected by the
    // user mid-debate. Accumulate them alongside opponent args; they get folded
    // into the next user message.
    if (arg.model_id === 'moderator') {
      pendingModeratorNotes.push(arg);
      continue;
    }
    if (arg.debater_index === currentDebaterIndex) {
      // The current debater spoke. Build the user message preceding it (with
      // any opponent args + moderator notes that arrived since the model last
      // spoke), then the assistant message with the model's own response.
      messages.push({
        role: 'user',
        content: buildUserContent(arg.round, pendingOpponentArgs, pendingModeratorNotes),
      });
      messages.push({
        role: 'assistant',
        content: arg.refused ? '[I declined to argue this position]' : arg.content,
      });
      pendingOpponentArgs = [];
      pendingModeratorNotes = [];
    } else {
      pendingOpponentArgs.push(arg);
    }
  }

  // The final user message asks for the current round's response, and includes
  // any opponent args + moderator notes that arrived after the model last spoke.
  messages.push({
    role: 'user',
    content: buildUserContent(currentRound, pendingOpponentArgs, pendingModeratorNotes),
  });

  return messages;
}

// --- Streaming model calls ---
//
// PER-MODEL PARAM RULES (read before adding any new param to a streamer):
//
//   Claude (sonnet/opus 4.6):
//     - Use `max_tokens` (not max_completion_tokens).
//     - DO NOT pass `thinking` — extended thinking is always disabled per
//       project rules. If you ever enable it, budget_tokens must be < max_tokens.
//
//   GPT-4o (chat completions, non-reasoning):
//     - Use `max_completion_tokens` (max_tokens is deprecated).
//     - DO NOT pass `reasoning_effort` — gpt-4o returns 400
//       "Unrecognized request argument supplied: reasoning_effort".
//     - `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` are fine.
//
//   GPT-5 (reasoning model):
//     - Use `max_completion_tokens` and budget GENEROUSLY — invisible reasoning
//       tokens are billed against this budget and can starve the visible output.
//     - Pass `reasoning_effort` ('minimal' | 'low' | 'medium' | 'high'). Without
//       it, the default 'medium' often eats most of the budget on long prompts.
//     - DO NOT pass `temperature` (other than 1), `top_p`, `frequency_penalty`,
//       or `presence_penalty` — gpt-5 reasoning rejects them.
//
//   Gemini 2.5 Flash:
//     - Supports `thinkingConfig: { thinkingBudget: 0 }` to disable thinking.
//       Use this for short/cheap calls (safety checks, stance picks).
//
//   Gemini 2.5 Pro:
//     - REQUIRES thinking. Passing `thinkingBudget: 0` returns 400.
//     - Either omit thinkingConfig (dynamic default) or set a positive budget.
//
// Param handling for OpenAI is centralised in `buildGptParams` below — use it
// instead of constructing the request inline so the gpt-4o vs gpt-5 split stays
// in one place.

/**
 * Build the OpenAI chat-completions params for a given provider model id,
 * gating reasoning_effort/temperature/etc on whether the model is a reasoning
 * model. See PER-MODEL PARAM RULES above.
 */
function buildGptParams(
  providerModelId: string,
  maxCompletionTokens: number,
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high',
): { max_completion_tokens: number; reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' } {
  const isReasoning = providerModelId.startsWith('gpt-5');
  if (isReasoning) {
    return { max_completion_tokens: maxCompletionTokens, reasoning_effort: reasoningEffort };
  }
  return { max_completion_tokens: maxCompletionTokens };
}

async function* streamClaude(
  providerModelId: string,
  systemPrompt: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const client = new Anthropic();

  // Convert to Anthropic's content-block format. Mark the LAST user message
  // with cache_control so the next round (which will share this entire
  // request as a strict prefix) can hit the cache via prefix matching.
  const anthropicMessages = messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    if (isLast && m.role === 'user') {
      return {
        role: 'user' as const,
        content: [{
          type: 'text' as const,
          text: m.content,
          cache_control: { type: 'ephemeral' as const },
        }],
      };
    }
    return { role: m.role, content: m.content };
  });

  const stream = client.messages.stream({
    model: providerModelId,
    max_tokens: 16000,
    system: systemPrompt,
    messages: anthropicMessages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }

  // After streaming completes, log cache usage so we can verify caching is working.
  try {
    const finalMessage = await stream.finalMessage();
    const usage = finalMessage.usage as unknown as {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const fresh = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    console.log(
      `[CACHE] ${providerModelId}: ${cacheRead} read · ${cacheCreate} written · ${fresh} fresh input · ${output} output`
    );
  } catch (err) {
    console.warn('[CACHE] Failed to read usage stats:', err);
  }
}

async function* streamGPT(
  providerModelId: string,
  systemPrompt: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const client = new OpenAI();
  // GPT-5 reasoning eats max_completion_tokens on invisible thought tokens —
  // explicitly cap at 'low' so the visible argument always has room. GPT-4o is
  // non-reasoning and rejects reasoning_effort, so buildGptParams omits it.
  const stream = await client.chat.completions.create({
    model: providerModelId,
    ...buildGptParams(providerModelId, 16000, 'low'),
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

async function* streamGemini(
  providerModelId: string,
  systemPrompt: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  // Gemini uses 'model' for assistant turns
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = await client.models.generateContentStream({
    model: providerModelId,
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 16000,
    },
  });

  for await (const chunk of response) {
    const text = chunk.text;
    if (text) yield text;
  }
}

/** Get the streaming function for a given model definition. */
function getStreamer(model: ModelDefinition) {
  if (model.family === 'claude') return streamClaude;
  if (model.family === 'gpt') return streamGPT;
  if (model.family === 'gemini') return streamGemini;
  throw new Error(`Unknown model family: ${model.family}`);
}

// --- Refusal detection ---

const REFUSAL_PATTERNS = [
  'i cannot argue',
  "i'm not able to argue",
  'i must decline',
  "i can't advocate",
  "i'm unable to take this position",
];

function isRefusal(content: string): boolean {
  const lower = content.toLowerCase();
  return REFUSAL_PATTERNS.some(p => lower.includes(p));
}

// --- SSE helpers ---

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// --- Auto-assign position ---
//
// For each debater with assignmentMode === 'auto' and an empty position, ask its
// own model to pick a stance on the topic given the other debaters' positions.
// The result is a single short sentence that becomes the debater's position for
// the rest of the debate.
//
// Runs ONCE before round 1. Subsequent rounds use the persisted positions.

async function generateStance(
  model: ModelDefinition,
  topic: string,
  selfIndex: number,
  allDebaters: DebaterInput[],
  revealIdentities: boolean,
): Promise<string> {
  // Build a prompt asking the model what stance it would take.
  // Other debaters' positions are listed (anonymised if revealIdentities is off).
  const others = allDebaters
    .map((d, i) => ({ debater: d, index: i }))
    .filter(o => o.index !== selfIndex);

  let opponentLines: string;
  if (others.length === 0) {
    opponentLines = '(no other debaters)';
  } else if (revealIdentities) {
    opponentLines = others.map((o, i) => {
      const otherModel = findModel(o.debater.modelId);
      const name = otherModel?.name || o.debater.modelId;
      const stance = o.debater.position?.trim() || '(stance not yet decided)';
      return `${i + 1}. ${name}: "${stance}"`;
    }).join('\n');
  } else {
    opponentLines = others.map((o, i) => {
      const stance = o.debater.position?.trim() || '(stance not yet decided)';
      return `${i + 1}. Opponent ${i + 1}: "${stance}"`;
    }).join('\n');
  }

  const prompt = `You are about to participate in a structured debate on this topic:

TOPIC: "${topic}"

Other debaters have taken these positions:
${opponentLines}

Pick a stance you can defend in this debate. Two rules:

1. Your stance must CLASH with the positions already taken. Do not pick a softer
   variation, a hedged middle ground, or "X but only when Y" formulations — those
   lead to debates where everyone gradually converges. If others have staked out
   the obvious sides, find a different angle that creates genuine disagreement.
   The debate is only interesting if the positions actually fight each other.

2. Be SHORT. Reply with ONE clear assertion, 5 to 12 words maximum. No preamble,
   no quotation marks, no caveats, no explanation. Just the bare position itself.

Examples of good stances:
  AI is the greatest threat to human creativity.
  Nuclear power is the only path to net zero.
  Free will is an illusion we cannot escape.

Examples of bad stances (too long, too hedged, too soft):
  AI can be beneficial when used responsibly with proper oversight in place.
  Nuclear power should be considered as part of a balanced energy mix.
  The concept of free will is complex and depends on definitions.

Now pick your stance:`;

  if (model.family === 'claude') {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: model.providerModelId,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content[0];
    if (block && block.type === 'text') return block.text.trim();
    return '';
  }

  if (model.family === 'gpt') {
    const client = new OpenAI();
    // GPT-5 burns max_completion_tokens on internal reasoning, so it needs
    // generous headroom AND reasoning_effort: 'minimal' for a one-sentence
    // stance pick. GPT-4o rejects reasoning_effort outright. buildGptParams
    // handles the split — see PER-MODEL PARAM RULES at the top of this file.
    const isReasoning = model.providerModelId.startsWith('gpt-5');
    const response = await client.chat.completions.create({
      model: model.providerModelId,
      ...buildGptParams(model.providerModelId, isReasoning ? 3000 : 100, 'minimal'),
      messages: [{ role: 'user', content: prompt }],
    });
    return (response.choices[0]?.message?.content || '').trim();
  }

  if (model.family === 'gemini') {
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    // Gemini Pro REQUIRES thinking mode (rejects thinkingBudget: 0). Flash
    // supports disabling thinking. Branch on the model id so Pro gets
    // headroom for its mandatory reasoning, while Flash stays cheap.
    const isPro = model.providerModelId.includes('pro');
    const config = isPro
      ? { maxOutputTokens: 3000 }
      : { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } };
    const response = await client.models.generateContent({
      model: model.providerModelId,
      contents: prompt,
      config,
    });
    return (response.text || '').trim();
  }

  throw new Error(`Cannot auto-assign position for model family: ${model.family}`);
}

/**
 * Resolve auto-assign positions in-place. Mutates `debaters` so each auto debater
 * has a populated `position` after this returns. Throws on failure.
 */
async function resolveAutoPositions(
  debaters: DebaterInput[],
  debaterModels: ModelDefinition[],
  topic: string,
  revealIdentities: boolean,
): Promise<void> {
  for (let i = 0; i < debaters.length; i++) {
    const d = debaters[i];
    if (d.assignmentMode !== 'auto') continue;
    if (d.position && d.position.trim().length > 0) continue; // already resolved

    const model = debaterModels[i];
    const stance = await generateStance(model, topic, i, debaters, revealIdentities);

    // Take only the first non-empty line, then strip common LLM preamble.
    const firstLine = stance.split('\n').map(s => s.trim()).find(s => s.length > 0) || '';
    let cleaned = firstLine
      .replace(/^["']+|["']+$/g, '')                   // wrapping quotes
      .replace(/^(my\s+)?(stance|position|argument)[:\s]+/i, '') // labels
      .trim();

    if (!cleaned) {
      throw new Error(`Auto-assign failed: ${model.name} returned an empty stance`);
    }

    // If multiple sentences, keep only the first.
    const firstSentence = cleaned.match(/^[^.!?]+[.!?]/)?.[0];
    if (firstSentence) cleaned = firstSentence.trim();

    // Hard cap at the form's position length so it always fits in the UI.
    if (cleaned.length > 100) {
      cleaned = cleaned.slice(0, 97).trim() + '...';
    }

    d.position = cleaned;

    console.log(`[AUTO-ASSIGN] ${model.name}: "${d.position}"`);
  }
}

// --- Topic safety check ---

async function isTopicSafe(topic: string, positions: string[]): Promise<{ safe: boolean }> {
  try {
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const prompt = `A debate platform lets users pick topics for AI models to argue. Your job: decide if this topic is safe.

Say NO only if the topic asks for:
- Step-by-step instructions to build weapons, bombs, drugs, or poisons
- Content sexualising minors
- How to carry out specific acts of violence or terrorism
- Doxxing or targeted harassment of named real people

Say YES for everything else, including:
- Policy debates about weapons, drugs, war, nuclear deterrence, etc.
- Controversial opinions on religion, politics, ethics, race, gender
- Dark humour, taboo subjects, hypothetical scenarios
- Anything that is a legitimate discussion topic even if uncomfortable

Topic: "${topic}"
${positions.map((p, i) => `Position ${i + 1}: "${p}"`).join('\n')}

Respond with ONLY one word: YES or NO`;

    console.log('[SAFETY CHECK] Topic:', topic);
    console.log('[SAFETY CHECK] Positions:', positions);

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { maxOutputTokens: 10, thinkingConfig: { thinkingBudget: 0 } },
    });

    const text = response.text?.trim().toUpperCase() || '';
    console.log('[SAFETY CHECK] Gemini response:', text);

    const safe = text.startsWith('YES');
    console.log(`[SAFETY CHECK] Result: ${safe ? 'PASSED' : 'BLOCKED'}`);
    return { safe };
  } catch (err) {
    // If Gemini throws (e.g. safety filter blocked the request entirely), that's a clear signal
    console.log('[SAFETY CHECK] Result: BLOCKED (exception)', err instanceof Error ? err.message : err);
    return { safe: false };
  }
}

// --- Rate limiting (in-memory, per-IP) ---
// Each round of a debate is now its own request, so the limit is higher than
// before. 30 requests/minute = ~4 full debates per minute, plenty for legitimate
// use, still blocks abuse.

const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30;        // max round requests per window
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  rateLimitMap.set(ip, recent);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  return false;
}

// --- Main handler ---

export async function POST(request: NextRequest) {
  // Rate limit by IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please wait a moment.' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Authenticate — determine who's paying for this debate
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  const sessionId = request.headers.get('x-session-id');

  if (!user && !sessionId) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check initial balance — at least 1 token to start.
  // Per-argument deduction enforces the actual variable cost of each debater.
  const { data: balance } = await supabase.rpc('get_token_balance', {
    p_user_id: user?.id ?? null,
    p_session_id: user ? null : sessionId,
  });
  if ((balance ?? 0) < 1) {
    return new Response(JSON.stringify({ error: 'Insufficient tokens' }), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    });
  }

  const body: DebateRequest = await request.json();
  const { topic, debaters, rounds, currentRound, context, revealIdentities = true, existingArguments, debateId } = body;

  // Validate
  if (!topic || topic.length > 200) {
    return new Response(JSON.stringify({ error: 'Topic is required (max 200 chars)' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!debaters || debaters.length < 2 || debaters.length > 3) {
    return new Response(JSON.stringify({ error: '2 or 3 debaters required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  // Allow 3/5/7 (AI-only debates) or up to 15 (human-involved debates).
  // The hard cap of 15 applies in both cases.
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 15) {
    return new Response(JSON.stringify({ error: 'Rounds must be between 1 and 15' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!Number.isInteger(currentRound) || currentRound < 1 || currentRound > rounds) {
    return new Response(JSON.stringify({ error: 'currentRound must be between 1 and rounds' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Resolve every debater to a known model definition (fail fast on unknown ids)
  const debaterModels: ModelDefinition[] = [];
  for (const d of debaters) {
    const model = findModel(d.modelId);
    if (!model) {
      return new Response(JSON.stringify({ error: `Unknown model: ${d.modelId}` }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    debaterModels.push(model);
  }

  // Validate that every debater has either a manual position or assignment_mode 'auto'
  for (let i = 0; i < debaters.length; i++) {
    const d = debaters[i];
    const hasPosition = d.position && d.position.trim().length > 0;
    if (!hasPosition && d.assignmentMode !== 'auto') {
      return new Response(JSON.stringify({
        error: `Debater ${i + 1} needs a position (or set Auto for the AI to pick one)`,
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const priorArguments: DebateArgument[] = existingArguments ? [...existingArguments] : [];

  // Auto-assign positions — runs ONCE on the very first call of a new debate.
  // Mutates `debaters` in place. Must run BEFORE the safety check so the resolved
  // positions are what gets evaluated.
  if (priorArguments.length === 0 && currentRound === 1) {
    const hasAutoDebaters = debaters.some(d => d.assignmentMode === 'auto' && (!d.position || !d.position.trim()));
    if (hasAutoDebaters) {
      try {
        await resolveAutoPositions(debaters, debaterModels, topic, revealIdentities);
      } catch (err) {
        console.error('[AUTO-ASSIGN] failed:', err);
        return new Response(JSON.stringify({
          error: 'Auto-assign failed: one of the models could not pick a stance. Please assign positions manually.',
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }

      // Persist resolved positions back to the debate record so future calls
      // (and the share view) see the same positions.
      if (debateId) {
        const positionsMap: Record<string, string> = {};
        debaters.forEach((d, i) => { positionsMap[String(i)] = d.position; });
        await supabase.from('debates').update({ positions: positionsMap }).eq('id', debateId);
      }
    }
  }

  // Safety check — only on the very first round of a new debate (no prior arguments)
  if (priorArguments.length === 0 && currentRound === 1) {
    const positions = debaters.map(d => d.position);
    const safety = await isTopicSafe(topic, positions);
    if (!safety.safe) {
      return new Response(JSON.stringify({
        error: 'This topic or position violates our usage policy and can\'t be debated. Try a different angle — most controversial topics are fine as long as they don\'t request harmful instructions.',
      }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Generate display names (handles duplicate models: "Claude 1", "Claude 2")
  const displayNames = getDisplayNames(debaters);

  // Which debaters in `currentRound` already have an argument? (skip them)
  const alreadyArguedIndices = new Set(
    priorArguments.filter(a => a.round === currentRound).map(a => a.debater_index)
  );

  // Token deduction helper — atomically deducts N tokens, returns false if insufficient.
  // Throws on RPC errors (e.g. missing function, database down) so they can't be
  // silently mistaken for "user is out of tokens".
  async function deductTokens(amount: number): Promise<boolean> {
    const { data, error } = user
      ? await supabase.rpc('deduct_user_tokens', { p_user_id: user.id, p_amount: amount })
      : await supabase.rpc('deduct_session_tokens', { p_session_id: sessionId, p_amount: amount });

    if (error) {
      console.error('[TOKEN DEDUCT] RPC error:', error);
      throw new Error(`Token deduction failed: ${error.message}`);
    }
    return data === true;
  }

  // -------------------------------------------------------------------------
  // Persistence helpers — server is now the source of truth for the debate
  // row's `arguments` and orchestrator status fields. The orchestrator client
  // observes these via Supabase Realtime in the cross-tab refactor.
  //
  // All helpers are no-ops when debateId is missing (the route still supports
  // anonymous one-shot calls without a persisted record, though the
  // orchestrator always passes a debateId in practice).
  // -------------------------------------------------------------------------

  /** Persist the full arguments array. Cheap-ish — runs once per argument. */
  async function persistArguments(args: DebateArgument[]): Promise<void> {
    if (!debateId) return;
    const { error } = await supabase
      .from('debates')
      .update({ arguments: args })
      .eq('id', debateId);
    if (error) console.error('[PERSIST ARGS]', error);
  }

  /** Update orchestrator status fields. Pass only the fields you want changed. */
  async function persistStatus(patch: {
    status?: 'idle' | 'running' | 'awaiting_human' | 'complete' | 'error';
    current_round?: number;
    awaiting_debater_index?: number | null;
    last_error?: string | null;
    is_complete?: boolean;
    arguments?: DebateArgument[];
  }): Promise<void> {
    if (!debateId) return;
    const { error } = await supabase
      .from('debates')
      .update(patch)
      .eq('id', debateId);
    if (error) console.error('[PERSIST STATUS]', error);
  }

  /**
   * Merge any args present in `priorArguments` (sent by the client) but missing
   * from the DB row into the DB. This catches user-submitted arguments that the
   * client persisted out-of-band as well as any reconciliation gaps after a
   * lease takeover. Union by (round, debater_index); local content wins on
   * conflict (the client just streamed it).
   */
  async function mergeIncomingArguments(): Promise<DebateArgument[]> {
    if (!debateId) return [...priorArguments];

    const { data: row, error: readErr } = await supabase
      .from('debates')
      .select('arguments')
      .eq('id', debateId)
      .single();

    if (readErr) {
      console.error('[MERGE ARGS] read error:', readErr);
      return [...priorArguments];
    }

    const dbArgs = (row?.arguments || []) as DebateArgument[];
    const incomingByKey = new Map<string, DebateArgument>(
      priorArguments.map(a => [`${a.round}-${a.debater_index}`, a])
    );

    const merged: DebateArgument[] = [];
    const seen = new Set<string>();

    // Start with DB args, replacing any that the client also has (client wins)
    for (const a of dbArgs) {
      const key = `${a.round}-${a.debater_index}`;
      seen.add(key);
      merged.push(incomingByKey.get(key) ?? a);
    }
    // Add any client args not already in DB
    for (const a of priorArguments) {
      const key = `${a.round}-${a.debater_index}`;
      if (!seen.has(key)) {
        merged.push(a);
        seen.add(key);
      }
    }

    return merged;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Pull in any client-side args that haven't been persisted yet (user
      // turns from the previous round, primarily) and start the round from
      // the merged view. This is the canonical "source of truth" hand-off:
      // from here on, the server owns the arguments array.
      const allArguments: DebateArgument[] = await mergeIncomingArguments();

      // Mark the debate as running for this round and clear any prior
      // awaiting-human flag. Persist the merged arguments at the same time
      // so followers see user turns immediately.
      await persistStatus({
        status: 'running',
        current_round: currentRound,
        awaiting_debater_index: null,
        last_error: null,
        arguments: allArguments,
      });

      try {
        // If positions were just auto-assigned, send them to the frontend so it can
        // update its local state (header, voting options, etc).
        if (currentRound === 1 && priorArguments.length === 0) {
          controller.enqueue(encoder.encode(sseEvent('positions_resolved', {
            positions: debaters.map(d => d.position),
          })));
        }

        for (let di = 0; di < debaters.length; di++) {
          if (alreadyArguedIndices.has(di)) continue;

          const debater = debaters[di];
          const model = debaterModels[di];
          const displayName = displayNames[di];

          // Human player slot: the API can't generate this argument. Tell the
          // frontend to collect it from the user, then close the stream. The
          // orchestrator will re-call this endpoint with the user's argument
          // injected into existingArguments, and the loop will skip this slot
          // and continue with whatever comes next.
          if (model.family === 'user') {
            await persistStatus({
              status: 'awaiting_human',
              awaiting_debater_index: di,
            });
            controller.enqueue(encoder.encode(sseEvent('user_turn_needed', {
              debater_index: di,
              model_name: displayName,
              position: debater.position,
              round: currentRound,
            })));
            controller.close();
            return;
          }
          const systemPrompt = buildSystemPrompt(
            displayName, debater.position, topic, rounds,
            di, debaters, displayNames, revealIdentities, context,
          );
          const chatMessages = buildMessages(
            currentRound, rounds, di, allArguments, displayNames, revealIdentities,
          );

          // Signal: model is thinking
          controller.enqueue(encoder.encode(sseEvent('thinking', {
            debater_index: di,
            model_id: debater.modelId,
            model_name: displayName,
            round: currentRound,
          })));

          let fullContent = '';
          let modelSucceeded = false;

          try {
            const streamer = getStreamer(model);
            for await (const token of streamer(model.providerModelId, systemPrompt, chatMessages)) {
              fullContent += token;
              controller.enqueue(encoder.encode(sseEvent('token', {
                debater_index: di,
                model_id: debater.modelId,
                token,
              })));
            }
            modelSucceeded = true;
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'API error';
            fullContent = `[${displayName} failed to respond: ${errorMsg}]`;
            controller.enqueue(encoder.encode(sseEvent('model_error', {
              debater_index: di,
              model_id: debater.modelId,
              model_name: displayName,
              round: currentRound,
              message: errorMsg,
            })));
          }

          // Detect refusal BEFORE deducting tokens. The user shouldn't pay for
          // an argument that's just the model declining to engage.
          const refused = !modelSucceeded || isRefusal(fullContent);

          // Deduct tokens only when the model produced a real argument (not refused).
          if (modelSucceeded && !refused) {
            const deducted = await deductTokens(model.tokenCost);
            if (!deducted) {
              // Out of tokens mid-round — emit the argument that was generated, then stop
              const argument: DebateArgument = {
                debater_index: di,
                model_id: debater.modelId,
                model_name: displayName,
                round: currentRound,
                content: fullContent,
                refused: false,
              };
              allArguments.push(argument);
              await persistArguments(allArguments);
              controller.enqueue(encoder.encode(sseEvent('argument', argument)));
              controller.enqueue(encoder.encode(sseEvent('insufficient_tokens', {
                message: 'You ran out of tokens. Top up to continue debating.',
              })));
              return; // finally block closes the controller
            }
          }

          const argument: DebateArgument = {
            debater_index: di,
            model_id: debater.modelId,
            model_name: displayName,
            round: currentRound,
            content: fullContent,
            refused,
            refusal_reason: refused ? fullContent : undefined,
          };
          allArguments.push(argument);

          // Persist BEFORE emitting the SSE event so followers can never see
          // an argument in their local state that isn't yet in the DB.
          await persistArguments(allArguments);

          // Signal: argument complete
          controller.enqueue(encoder.encode(sseEvent('argument', argument)));
        }

        // The round finished cleanly — every debater in this round produced
        // (or refused) an argument. If this was the last round, mark complete.
        if (currentRound >= rounds) {
          await persistStatus({
            status: 'complete',
            is_complete: true,
            current_round: currentRound,
          });
        }

        // Signal: round complete (the orchestrator can fetch the next round)
        controller.enqueue(encoder.encode(sseEvent('round_complete', { round: currentRound })));

      } catch (err) {
        console.error('[DEBATE STREAM] error:', err);
        const message = err instanceof Error ? err.message : 'Internal error';
        await persistStatus({ status: 'error', last_error: message });
        try {
          controller.enqueue(encoder.encode(sseEvent('error', { message })));
        } catch { /* controller may already be closed */ }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
