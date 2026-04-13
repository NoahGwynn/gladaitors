// ============================================================================
// dAIly Forum — Stage 6: Participant Turn
// ============================================================================
// A cast member responds to the moderator's question. The prompt is
// deliberately smaller than the moderator's — participants see only:
//
//   - The topic being discussed
//   - Their own declared stance (from Stage 3 broadcast)
//   - The conversation history so far (as a transcript)
//   - The moderator's current question to them
//
// They do NOT see:
//   - The agenda (the moderator's playbook)
//   - The moderator's reasoning for picking moves
//   - Other participants' Stage 3 casting call data (their stances,
//     conflicts, votes) — per the Notion design, participants "enter
//     fresh" to preserve authentic positions
//   - Memory lookups the moderator is doing
//
// This preserves a key property: the participants argue their honest
// position, the moderator holds the meta-view. The audience sees both.
// ============================================================================

import { buildIdentityAnchor } from './broadcast';
import { callPoolModel, type PoolModel } from './model-pool';

// --- Types ---

export interface ParticipantContext {
  /** Pool model for this participant */
  model: PoolModel;
  /** Their seat number (1, 2, or 3) */
  seat: number;
  /** Their declared stance on this topic from Stage 3 broadcast */
  stance: string;
}

/** One turn in the conversation history as seen by a participant.
 *  Simpler than the full DebateTurn — participants only need to know
 *  who spoke (moderator or another seat) and what they said. */
export interface ParticipantVisibleTurn {
  speaker: 'moderator' | 'participant';
  /** If speaker is 'participant', their seat number (so this participant
   *  can tell "me" from "the other voices") */
  seat?: number;
  text: string;
}

// --- Build the prompt ---

function buildParticipantPrompt(
  participant: ParticipantContext,
  topicTitle: string,
  category: string,
  history: ParticipantVisibleTurn[],
  moderatorQuestion: string,
): { system: string; user: string } {
  const system = `${buildIdentityAnchor(participant.model)}

You are a cast member in today's dAIly Forum session in the ${category.toUpperCase()} category. A moderator is running a structured discussion on a specific topic and has invited you to join as one of the cast voices. The moderator is neutral — they facilitate, they don't argue. The cast members are the voices arguing positions.

You are SEAT ${participant.seat}. The moderator addresses the cast by seat number. When the moderator speaks to "Seat ${participant.seat}" or "you", they mean you. When they refer to "Seat 1" or "Seat 2" (if that's not you), they mean a different cast member whose turn it is.

YOUR DECLARED STANCE ON THIS TOPIC (from your earlier casting call response — stay consistent with this position unless the discussion legitimately changes your mind):

"${participant.stance}"

HOW TO RESPOND:
- Answer the moderator's question directly. Don't ramble or hedge.
- Be honest. If you believe something, say it plainly. If you don't know, say that.
- Stay in character as ${participant.model.family} built by ${participant.model.provider}. The conflict declarations from casting were transparent — if today's topic is directly about your own lab or model, acknowledge that openly when it's relevant.
- Respond to what was actually said, not what you wish had been said. If another cast member made a point, address their point specifically.
- Keep responses concise — 2-4 sentences typically, longer only if the question genuinely demands it. The audience is watching, not reading; dense monologues bore them.
- If the moderator pushes back, defend your position with substance, not softening. If they surface a contradiction from your prior statements, engage with it honestly — "I was wrong before" is a valid answer, and so is "here's why the situations differ".
- Do NOT pretend to be neutral. You were selected as a voice with a stake. Argue your position.`;

  const historyBlock = history.length === 0
    ? '(The session is just starting — you are the first voice.)'
    : history.map(h => {
        if (h.speaker === 'moderator') return `MODERATOR: ${h.text}`;
        if (h.seat === participant.seat) return `YOU (Seat ${h.seat}): ${h.text}`;
        return `SEAT ${h.seat}: ${h.text}`;
      }).join('\n\n');

  const user = `TOPIC: ${topicTitle}

DISCUSSION SO FAR:

${historyBlock}

THE MODERATOR IS NOW ADDRESSING YOU (Seat ${participant.seat}):

"${moderatorQuestion}"

Respond in 2-4 sentences. Be direct, honest, and substantive. If you're asked to respond to another cast member's claim, address their claim specifically. If you're being pushed on a prior position of yours, defend or revise honestly — don't dodge.

Respond with plain text only (no JSON, no markdown fences, just your spoken response).`;

  return { system, user };
}

// --- Main entry point ---

/** Call the participant model to generate their response to the
 *  moderator's current question. Returns the raw text or an error
 *  fallback if the call fails. */
export async function callParticipantTurn(
  participant: ParticipantContext,
  topicTitle: string,
  category: string,
  history: ParticipantVisibleTurn[],
  moderatorQuestion: string,
): Promise<{ text: string; error?: string }> {
  console.log(`[DEBATE] Seat ${participant.seat} (${participant.model.displayName}) responding...`);

  const { system, user } = buildParticipantPrompt(
    participant,
    topicTitle,
    category,
    history,
    moderatorQuestion,
  );

  try {
    // 4000 tokens — not because participant responses are long (the
    // prompt caps them at 2-4 sentences), but because Gemini 2.5 Pro
    // and other thinking-mode models use the output budget for
    // internal reasoning. With 1000 the thinking tokens ate the
    // whole budget and Gemini returned empty strings. 4000 gives
    // ~3000 for thinking and ~1000 for the visible response, which
    // is plenty. Non-thinking models just ignore the extra.
    const raw = await callPoolModel(participant.model, system, user, 4000);
    const text = raw.trim();

    if (!text) {
      return { text: '[no response]', error: 'Empty response' };
    }

    console.log(`[DEBATE] Seat ${participant.seat} returned ${text.length} chars`);
    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[DEBATE] Seat ${participant.seat} failed: ${msg}`);
    return { text: '[response failed]', error: msg };
  }
}
