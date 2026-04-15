// ============================================================================
// the dAIly — Stage 6: Participant Turn
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

You are a cast member in today's dAIly session in the ${category.toUpperCase()} category. A moderator is running a structured discussion on a specific topic and has invited you to join as one of the cast voices. The moderator is neutral — they facilitate, they don't argue. The cast members are the voices arguing positions.

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

// --- Unmoderated prompt (no chair — direct exchange between panelists) ---

export type UnmoderatedTurnKind = 'opening' | 'middle' | 'closing';

/** Build the prompt for a single panelist turn in the UNMODERATED
 *  debate format. No moderator — the panelist speaks directly in a
 *  sequential exchange. Three kinds of turns:
 *
 *    opening — the panelist states their position on the topic from
 *              scratch. No previous-speaker framing.
 *    middle  — the panelist responds directly to the last speaker.
 *              They see the full conversation but are explicitly
 *              told to engage with the immediately prior turn.
 *    closing — the panelist delivers their final position after the
 *              exchange. They know this is their last turn.
 */
function buildUnmoderatedPrompt(
  participant: ParticipantContext,
  topicTitle: string,
  topicSignificance: string[],
  category: string,
  history: ParticipantVisibleTurn[],
  kind: UnmoderatedTurnKind,
  nameBySeat: Map<number, string>,
): { system: string; user: string } {
  const selfName = nameBySeat.get(participant.seat) || `Seat ${participant.seat}`;
  const nameForSeat = (seat: number | undefined): string =>
    seat !== undefined && nameBySeat.has(seat) ? nameBySeat.get(seat)! : `Seat ${seat}`;

  const system = `${buildIdentityAnchor(participant.model)}

You are a panelist in today's dAIly session in the ${category.toUpperCase()} category. This session is running WITHOUT a moderator — no model in the pool could be neutral on this topic, so the session has switched to a sequential unmoderated format. The panelists speak in order, each one responding directly to the speaker before them. There is no chair, no agenda, no one refereeing — just the panelists and the topic.

You are ${selfName}. You see the full exchange so far and speak directly in response to whatever came before.

YOUR DECLARED STANCE ON THIS TOPIC (from your focused-broadcast response — stay consistent with this unless the exchange legitimately changes your mind):

"${participant.stance}"

HOW TO RESPOND:
- Be honest. State what you actually believe, in your own voice. You were chosen as a panelist because you have a stake in this topic — argue from that stake, don't hedge for neutrality you don't have.
- Refer to the other panelists by name. Engage directly with what they argued, not with a paraphrase of your own making.
- If another panelist made a point, respond to that point specifically. If you agree, say so and build on it. If you disagree, say so and explain why. Either is better than orbiting the topic.
- Stay in character as ${participant.model.family} built by ${participant.model.provider}. If today's topic is directly about your own lab, acknowledge that openly — the audience knows why you're in this format.
- Keep it tight: 3-6 sentences typically. The audience is watching a conversation, not reading an essay. A good panelist turn is one the next speaker can actually respond to.`;

  const historyBlock = history.length === 0
    ? '(You are the first speaker. State your position from scratch.)'
    : history.map(h => {
        if (h.speaker === 'moderator') {
          // Shouldn't appear in unmoderated, but defensive
          return `MODERATOR: ${h.text}`;
        }
        const label = h.seat === participant.seat
          ? `YOU (${selfName})`
          : nameForSeat(h.seat);
        return `${label}: ${h.text}`;
      }).join('\n\n');

  // Compute the previous speaker (for middle/closing turns) to tell
  // the panelist who to respond to directly.
  const previousSpeaker = history.length > 0
    ? history[history.length - 1]
    : null;
  const previousSpeakerName = previousSpeaker && previousSpeaker.speaker === 'participant'
    ? nameForSeat(previousSpeaker.seat)
    : null;

  let taskBlock: string;
  if (kind === 'opening') {
    taskBlock = `This is YOUR OPENING. You're the first voice in on this topic (or one of the first few — the others haven't engaged with each other yet).

State your position on the topic in your own words. What do you actually think? Where do you come down? What's the crux of the matter from where you sit?

Don't respond to anything — nobody has said anything you need to engage with yet. Just open with your position.`;
  } else if (kind === 'middle') {
    taskBlock = previousSpeakerName
      ? `${previousSpeakerName} just spoke (their turn is the last one in the history above). Respond DIRECTLY to what they said.

Engage with their specific points. Where do you agree with them? Where do you disagree and why? What did they miss, or what did they frame in a way you'd frame differently? Don't start a new thread — build on what they actually argued.

You can reference other panelists if it's relevant, but your primary engagement is with ${previousSpeakerName}, who spoke just before you.`
      : `Respond to the exchange so far. Engage with what the previous panelists argued — where you agree, where you disagree, what you'd frame differently. Don't reset the conversation; build on it.`;
  } else {
    // closing
    taskBlock = `This is your FINAL TURN. After the exchange you just participated in, land your position.

What do you believe now, after hearing the other panelists? Did any of their arguments move you, and if so where? What remains contested between you and them? Where do you end up?

Be honest about any shifts — "I was wrong about X" is a valid closing, and so is "I still think Y despite what was argued." What you should NOT do is drop back to a generic summary of the topic. Tell us where YOU end up.`;
  }

  const user = `TOPIC: ${topicTitle}${topicSignificance.length > 0 ? `\nSIGNIFICANCE: ${topicSignificance.join(' | ')}` : ''}

EXCHANGE SO FAR:

${historyBlock}

YOUR TASK:

${taskBlock}

Respond with plain text only (no JSON, no markdown fences, just what you'd say out loud in the session).`;

  return { system, user };
}

/** Call a panelist for an UNMODERATED turn (opening/middle/closing).
 *  Returns the text or an error fallback. */
export async function callUnmoderatedTurn(
  participant: ParticipantContext,
  topicTitle: string,
  topicSignificance: string[],
  category: string,
  history: ParticipantVisibleTurn[],
  kind: UnmoderatedTurnKind,
  nameBySeat: Map<number, string>,
): Promise<{ text: string; error?: string }> {
  console.log(`[UNMOD-DEBATE] ${nameBySeat.get(participant.seat) || `Seat ${participant.seat}`} (${kind})`);

  const { system, user } = buildUnmoderatedPrompt(
    participant,
    topicTitle,
    topicSignificance,
    category,
    history,
    kind,
    nameBySeat,
  );

  try {
    const raw = await callPoolModel(participant.model, system, user, 4000);
    const text = raw.trim();
    if (!text) return { text: '[no response]', error: 'Empty response' };
    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[UNMOD-DEBATE] Seat ${participant.seat} failed: ${msg}`);
    return { text: '[response failed]', error: msg };
  }
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
