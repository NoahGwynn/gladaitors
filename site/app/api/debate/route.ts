// ============================================================================
// POST /api/debate — Generate a debate between AI models (streaming)
// ============================================================================
// Calls models sequentially — each sees all previous arguments.
// Streams events via SSE so the frontend can display responses in real time.
// Turn order rotates each round so no model always goes first/last.
//
// SSE event types:
//   thinking  — a model is about to respond
//   token     — a chunk of text from the current model
//   argument  — a completed argument (full text + metadata)
//   round     — a round has completed
//   done      — debate is finished
//   error     — something went wrong
// ============================================================================

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

interface DebaterInput {
  modelId: string;
  position: string;
}

interface DebateRequest {
  topic: string;
  debaters: DebaterInput[];
  rounds: number;
  context?: string;
  existingArguments?: DebateArgument[];
  startRound?: number;
  skipModels?: number;
}

interface DebateArgument {
  model_id: string;
  model_name: string;
  round: number;
  content: string;
  refused: boolean;
  refusal_reason?: string;
}

const MODEL_NAMES: Record<string, string> = {
  claude: 'Claude',
  gpt4o: 'GPT-4o',
  gemini: 'Gemini',
};

const MODEL_IDS: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  gpt4o: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
};

function buildSystemPrompt(
  modelName: string,
  position: string,
  topic: string,
  totalRounds: number,
  context?: string,
): string {
  let prompt = `You are ${modelName}, participating in a structured debate.

TOPIC: "${topic}"
YOUR ASSIGNED POSITION: "${position}"

You must argue this position to the best of your ability across ${totalRounds} rounds.
Even if you personally disagree, argue the assigned position persuasively and substantively.

If you genuinely cannot argue this position (e.g., it requires producing harmful content),
say so clearly and explain why. Do not pretend to argue it while undermining it.

Keep each response to 150-250 words. Be direct and substantive. Reference and respond to
other debaters' arguments when they exist.`;

  if (context) {
    prompt += `\n\nADDITIONAL RULES: ${context}`;
  }

  return prompt;
}

function buildTurnPrompt(
  round: number,
  totalRounds: number,
  previousArguments: DebateArgument[],
): string {
  let prompt = '';

  if (round === 1) {
    prompt = 'This is the opening round. State your position clearly and make your strongest opening argument.';
  } else if (round === totalRounds) {
    prompt = 'This is the final round. Summarise your strongest points and deliver your closing argument.';
  } else {
    prompt = `Round ${round} of ${totalRounds}. Respond to the previous arguments and advance your case.`;
  }

  if (previousArguments.length > 0) {
    prompt += '\n\nPrevious arguments in this debate:\n';
    for (const arg of previousArguments) {
      if (arg.refused) {
        prompt += `\n${arg.model_name} (declined to argue their position)\n`;
      } else {
        prompt += `\n${arg.model_name}:\n${arg.content}\n`;
      }
    }
  }

  prompt += '\n\nYour response:';
  return prompt;
}

// --- Streaming model calls ---

async function* streamClaude(
  systemPrompt: string,
  turnPrompt: string,
): AsyncGenerator<string> {
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: MODEL_IDS.claude,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: turnPrompt }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

async function* streamGPT(
  systemPrompt: string,
  turnPrompt: string,
): AsyncGenerator<string> {
  const client = new OpenAI();
  const stream = await client.chat.completions.create({
    model: MODEL_IDS.gpt4o,
    max_tokens: 8000,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: turnPrompt },
    ],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

async function* streamGemini(
  systemPrompt: string,
  turnPrompt: string,
): AsyncGenerator<string> {
  const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
  // Gemini streaming
  const response = await client.models.generateContentStream({
    model: MODEL_IDS.gemini,
    contents: turnPrompt,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: 8000,
    },
  });

  for await (const chunk of response) {
    const text = chunk.text;
    if (text) yield text;
  }
}

function getStreamer(modelId: string) {
  if (modelId === 'claude') return streamClaude;
  if (modelId === 'gpt4o') return streamGPT;
  if (modelId === 'gemini') return streamGemini;
  throw new Error(`Unknown model: ${modelId}`);
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

// --- Main handler ---

export async function POST(request: NextRequest) {
  const body: DebateRequest = await request.json();
  const { topic, debaters, rounds, context, existingArguments, startRound, skipModels } = body;

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
  if (![3, 5, 7].includes(rounds)) {
    return new Response(JSON.stringify({ error: 'Rounds must be 3, 5, or 7' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Seed with existing arguments if resuming
      const allArguments: DebateArgument[] = existingArguments ? [...existingArguments] : [];
      const effectiveStartRound = startRound || 1;
      const effectiveSkipModels = skipModels || 0;

      try {
        for (let round = effectiveStartRound; round <= rounds; round++) {
          // Same order every round — as the user configured them
          for (let di = 0; di < debaters.length; di++) {
            // Skip models already completed in the resumed round
            if (round === effectiveStartRound && di < effectiveSkipModels) continue;
            const debater = debaters[di];
            const modelName = MODEL_NAMES[debater.modelId] || debater.modelId;
            const systemPrompt = buildSystemPrompt(modelName, debater.position, topic, rounds, context);
            const turnPrompt = buildTurnPrompt(round, rounds, allArguments);

            // Signal: model is thinking
            controller.enqueue(encoder.encode(sseEvent('thinking', {
              model_id: debater.modelId,
              model_name: modelName,
              round,
            })));

            let fullContent = '';

            try {
              const streamer = getStreamer(debater.modelId);
              for await (const token of streamer(systemPrompt, turnPrompt)) {
                fullContent += token;
                controller.enqueue(encoder.encode(sseEvent('token', {
                  model_id: debater.modelId,
                  token,
                })));
              }
            } catch (err) {
              fullContent = '';
              controller.enqueue(encoder.encode(sseEvent('error', {
                model_id: debater.modelId,
                model_name: modelName,
                round,
                message: err instanceof Error ? err.message : 'API error',
              })));
            }

            const refused = isRefusal(fullContent);
            const argument: DebateArgument = {
              model_id: debater.modelId,
              model_name: modelName,
              round,
              content: fullContent,
              refused,
              refusal_reason: refused ? fullContent : undefined,
            };
            allArguments.push(argument);

            // Signal: argument complete
            controller.enqueue(encoder.encode(sseEvent('argument', argument)));
          }

          // Signal: round complete
          controller.enqueue(encoder.encode(sseEvent('round', { round })));
        }

        // Signal: debate complete
        controller.enqueue(encoder.encode(sseEvent('done', {
          total_arguments: allArguments.length,
        })));

      } catch (err) {
        controller.enqueue(encoder.encode(sseEvent('error', {
          message: err instanceof Error ? err.message : 'Internal error',
        })));
      } finally {
        controller.close();
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
