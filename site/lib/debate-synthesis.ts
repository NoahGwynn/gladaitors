// ============================================================================
// Debate decision synthesis — v3 utility pivot (Notion Phase 3)
// ============================================================================
// Runs after a debate completes. Asks a Sonnet-class model to produce
// a structured decision-support synthesis of the full transcript:
//
//   1. What each side surfaced — the strongest arguments each debater
//      actually made (distinct from moderator commentary — there is no
//      moderator in user-initiated Debate)
//   2. Tensions — the 2-3 deepest points of disagreement, phrased as
//      questions that would meaningfully shift the decision if answered
//   3. Summary — a two-sentence "if you remember nothing else" distill
//
// This is the synthesis the user reads to decide. The debate itself is
// the evidence; the synthesis is the tool's actual output.
//
// Cost: one Claude Sonnet call per debate completion. ~£0.05-0.15
// depending on debate length. Trivial compared to generation.
//
// The user's "what would change your mind" response and optional
// "user decision + rationale" are collected separately via form
// inputs on the debate view and persist as separate columns.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import type { DebateArgument } from './types';
import { getModelName } from './models';

export interface DecisionSynthesis {
  /** What each side surfaced — keyed by debater seat index (0, 1, 2...).
   *  Each value is a short list of the strongest points that debater
   *  actually made across all their rounds. Not moderator commentary —
   *  these are direct summaries of what the debater argued. */
  eachSideSurfaced: Array<{
    seat: number;
    modelName: string;
    position: string;
    strongestPoints: string[];
  }>;
  /** The 2-3 deepest tensions in the debate — where the two sides
   *  really disagree, phrased as questions whose answers would shift
   *  a reader's decision. */
  tensions: string[];
  /** Two-sentence "if you remember nothing else" distillation of
   *  what the debate produced. */
  summary: string;
  /** ISO timestamp when this synthesis was generated */
  generatedAt: string;
  /** Which model generated the synthesis */
  synthesisModelId: string;
}

export interface SynthesisInput {
  topic: string;
  context: string | null;
  templateName: string | null;
  debaters: Array<{
    seat: number;
    modelId: string;
    position: string;
  }>;
  debateArguments: DebateArgument[];
}

// --- Build the synthesis prompt ---

function buildSynthesisPrompt(input: SynthesisInput): { system: string; user: string } {
  const system = `You are producing a decision-support synthesis of a completed debate. The user ran two (or three) frontier AI models arguing opposing positions on a decision they're trying to make. Your job is to extract what each side actually argued and surface the real tensions, so the user can make a clearer call.

This is NOT a summary of the debate's rhetoric. It's a structured extract that helps a decision-maker act on the content.

WHAT TO PRODUCE

1. WHAT EACH SIDE SURFACED
   For each debater, list the 3-5 strongest substantive points they actually made across all their rounds. Quote or closely paraphrase. Skip pleasantries, introductions, and rhetorical framings — only include the actual arguments with decision-relevant content.

   Do NOT invent arguments the debater didn't make. Do NOT smooth over weakness. If a debater made one strong point and three weak ones, list the one strong point and say so. The user is making a decision — they need to know what the actual evidence on each side is.

2. TENSIONS
   Identify the 2-3 deepest points of disagreement between the sides. Phrase each as a QUESTION whose answer would meaningfully shift a reasonable decision-maker's view. Not "which side is right" — something like "how quickly can we validate assumption X?" or "what's the cost of being wrong about Y?"

   Tensions are the load-bearing questions. A user reading the synthesis should think: "ah, those are the three things I actually need to find out before I decide."

3. SUMMARY
   Two sentences. No more. What the debate produced — framed so that a user who skipped the transcript can decide whether to read it in full or act on the synthesis alone.

STYLE

- Neutral voice. Do not take sides. Do not editorialise.
- Concrete over abstract. "Shipping to EU before UK adds 4-6 weeks of compliance work" beats "timeline concerns exist".
- Specific over generic. Name the debater when citing their point.
- If the debate ended weakly (refusals, hedging, one side clearly out-argued), say so — don't manufacture balance.

OUTPUT

Respond with JSON only. Use this shape exactly:

{
  "eachSideSurfaced": [
    {
      "seat": 0,
      "strongestPoints": [
        "Short concrete point 1",
        "Short concrete point 2",
        "Short concrete point 3"
      ]
    },
    {
      "seat": 1,
      "strongestPoints": [ ... ]
    }
  ],
  "tensions": [
    "A specific question whose answer would shift the decision",
    "Another specific question",
    "A third"
  ],
  "summary": "Two-sentence distillation."
}`;

  const templateLine = input.templateName
    ? `DEBATE TEMPLATE: ${input.templateName}\n\n`
    : '';

  const debaterBlock = input.debaters
    .map((d) => `Seat ${d.seat} — ${getModelName(d.modelId)}\n  Position: ${d.position}`)
    .join('\n\n');

  const transcriptBlock = input.debateArguments
    .filter((a) => !a.refused && typeof a.content === 'string' && a.content.trim().length > 0)
    .map((a) => {
      const name = getModelName(a.model_id) || `Seat ${a.model_id}`;
      return `[Round ${a.round} — ${name}]\n${a.content}`;
    })
    .join('\n\n---\n\n');

  const user = `${templateLine}TOPIC: ${input.topic}

${input.context ? `CONTEXT:\n${input.context}\n\n` : ''}DEBATERS:

${debaterBlock}

FULL DEBATE TRANSCRIPT:

${transcriptBlock}

Produce the decision synthesis per the system prompt. Return JSON only.`;

  return { system, user };
}

// --- Parse the synthesis response ---

function parseSynthesisResponse(
  raw: string,
  debaters: SynthesisInput['debaters'],
): { eachSideSurfaced: DecisionSynthesis['eachSideSurfaced']; tensions: string[]; summary: string } | { error: string } {
  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return { error: 'No JSON object in response' };

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const rawSides = Array.isArray(parsed.eachSideSurfaced) ? parsed.eachSideSurfaced : [];
    const eachSideSurfaced: DecisionSynthesis['eachSideSurfaced'] = (rawSides as Array<Record<string, unknown>>)
      .map((s) => {
        const seat = typeof s.seat === 'number' ? s.seat : -1;
        const debater = debaters.find((d) => d.seat === seat);
        const strongestPoints = Array.isArray(s.strongestPoints)
          ? (s.strongestPoints as unknown[]).map(String).filter((p) => p.trim().length > 0)
          : [];
        return {
          seat,
          modelName: debater ? getModelName(debater.modelId) : `Seat ${seat}`,
          position: debater?.position || '',
          strongestPoints,
        };
      })
      .filter((s) => s.seat >= 0);

    const tensions = Array.isArray(parsed.tensions)
      ? (parsed.tensions as unknown[]).map(String).filter((t) => t.trim().length > 0)
      : [];

    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

    return { eachSideSurfaced, tensions, summary };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'parse failed' };
  }
}

// --- Main entry point ---

/** Generate a decision synthesis for a completed debate. Server-side
 *  only — requires ANTHROPIC_API_KEY. Throws on hard failure (API
 *  down, bad response). Partial failures (empty tensions array etc.)
 *  are tolerated — the caller gets a valid-shape result with whatever
 *  the model actually produced. */
export async function generateDecisionSynthesis(
  input: SynthesisInput,
): Promise<DecisionSynthesis> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot generate synthesis');
  }

  const client = new Anthropic();
  const { system, user } = buildSynthesisPrompt(input);

  console.log('[SYNTHESIS] Generating for debate topic:', input.topic.slice(0, 80));
  const startedAt = Date.now();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const block = response.content[0];
  const raw = block?.type === 'text' ? block.text : '';

  const parsed = parseSynthesisResponse(raw, input.debaters);
  if ('error' in parsed) {
    throw new Error(`Failed to parse synthesis: ${parsed.error}`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[SYNTHESIS] Done in ${elapsed}s: ${parsed.eachSideSurfaced.length} sides, ${parsed.tensions.length} tensions`);

  return {
    ...parsed,
    generatedAt: new Date().toISOString(),
    synthesisModelId: 'claude-sonnet-4-6',
  };
}
