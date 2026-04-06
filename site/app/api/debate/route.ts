// ============================================================================
// POST /api/debate — Generate a debate between AI models
// ============================================================================
// Calls each model sequentially (each needs to see previous arguments).
// Returns the full debate as an array of arguments.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
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

async function callModel(
  modelId: string,
  systemPrompt: string,
  turnPrompt: string,
): Promise<string> {
  if (modelId === 'claude') {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL_IDS.claude,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: turnPrompt }],
    });
    for (const block of response.content) {
      if (block.type === 'text' && block.text) return block.text;
    }
    return '';
  }

  if (modelId === 'gpt4o') {
    const client = new OpenAI();
    const response = await client.chat.completions.create({
      model: MODEL_IDS.gpt4o,
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: turnPrompt },
      ],
    });
    return response.choices[0]?.message?.content || '';
  }

  if (modelId === 'gemini') {
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const response = await client.models.generateContent({
      model: MODEL_IDS.gemini,
      contents: turnPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 500,
      },
    });
    return response.text || '';
  }

  throw new Error(`Unknown model: ${modelId}`);
}

export async function POST(request: NextRequest) {
  try {
    const body: DebateRequest = await request.json();
    const { topic, debaters, rounds, context } = body;

    // Validate
    if (!topic || topic.length > 200) {
      return NextResponse.json({ error: 'Topic is required (max 200 chars)' }, { status: 400 });
    }
    if (!debaters || debaters.length < 2 || debaters.length > 3) {
      return NextResponse.json({ error: '2 or 3 debaters required' }, { status: 400 });
    }
    if (![3, 5, 7].includes(rounds)) {
      return NextResponse.json({ error: 'Rounds must be 3, 5, or 7' }, { status: 400 });
    }

    const allArguments: DebateArgument[] = [];

    // Run each round sequentially
    for (let round = 1; round <= rounds; round++) {
      // Each model argues in sequence within the round
      for (const debater of debaters) {
        const modelName = MODEL_NAMES[debater.modelId] || debater.modelId;
        const systemPrompt = buildSystemPrompt(
          modelName, debater.position, topic, rounds, context,
        );
        const turnPrompt = buildTurnPrompt(round, rounds, allArguments);

        try {
          const content = await callModel(debater.modelId, systemPrompt, turnPrompt);

          // Check for refusal patterns
          const refusalPatterns = [
            'I cannot argue',
            'I\'m not able to argue',
            'I must decline',
            'I can\'t advocate',
            'I\'m unable to take this position',
          ];
          const isRefusal = refusalPatterns.some(p =>
            content.toLowerCase().includes(p.toLowerCase())
          );

          allArguments.push({
            model_id: debater.modelId,
            model_name: modelName,
            round,
            content,
            refused: isRefusal,
            refusal_reason: isRefusal ? content : undefined,
          });
        } catch (err) {
          allArguments.push({
            model_id: debater.modelId,
            model_name: modelName,
            round,
            content: '',
            refused: true,
            refusal_reason: `API error: ${err instanceof Error ? err.message : 'unknown'}`,
          });
        }
      }
    }

    return NextResponse.json({ arguments: allArguments });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
