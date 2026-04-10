// ============================================================================
// POST /api/games/territory-war — Run a Territory War game (streaming)
// ============================================================================
// Creates a new game, runs all turns sequentially (each model takes
// actions per tick), streams events via SSE, and persists every turn
// to the database for replay.
//
// SSE event types:
//   game_started    — initial state + game id
//   turn_start      — which model is about to act
//   turn_actions    — a model's actions + resulting state changes
//   tick_complete   — all models have acted, tick advanced
//   game_over       — winner, scores, reason
//   error           — unrecoverable error
//
// Similar in shape to the debate route but adapted for the sequential-
// turn game model instead of round-by-round debate orchestration.
// ============================================================================

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { createServerSupabase } from '@/lib/supabase-server';
import { findModel, type ModelDefinition } from '@/lib/models';
import {
  createGame,
  applyActions,
  advanceTick,
  buildSystemPrompt,
  buildTurnPrompt,
  RESOURCE_REVEAL_TICK,
  RESOURCE_REVEAL_SIZE,
  RESOURCE_REVEAL_AMOUNT,
  GRID_SIZE,
  SPAWN_CORNERS,
} from '@/lib/games/territory-war';
import type {
  GameState,
  PieceAction,
  TerritoryWarResponse,
} from '@/lib/games/territory-war';

// --- Request body ---

interface GameRequest {
  /** Model variant ids (2-4). Same ids as the debate model picker. */
  models: string[];
}

// --- SSE helper ---

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// --- AI model call (non-streaming, returns JSON actions) ---

async function callModel(
  model: ModelDefinition,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ actions: PieceAction[]; raw: string; error?: string }> {
  try {
    if (model.family === 'claude') {
      const client = new Anthropic();
      const response = await client.messages.create({
        model: model.providerModelId,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      return parseActions(text);
    }

    if (model.family === 'gpt') {
      const client = new OpenAI();
      const isReasoning = model.providerModelId.startsWith('gpt-5');
      const response = await client.chat.completions.create({
        model: model.providerModelId,
        max_completion_tokens: isReasoning ? 4000 : 2000,
        ...(isReasoning ? { reasoning_effort: 'low' as const } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      const text = response.choices[0]?.message?.content || '';
      return parseActions(text);
    }

    if (model.family === 'gemini') {
      const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
      const isPro = model.providerModelId.includes('pro');
      const config = isPro
        ? { maxOutputTokens: 4000 }
        : { maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } };
      const response = await client.models.generateContent({
        model: model.providerModelId,
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] },
        ],
        config,
      });
      const text = response.text || '';
      return parseActions(text);
    }

    return { actions: [], raw: '', error: `Unsupported model family: ${model.family}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'API error';
    console.error(`[GAME] ${model.name} call failed:`, msg);
    return { actions: [], raw: '', error: msg };
  }
}

// --- Parse JSON actions from model response ---

function parseActions(raw: string): { actions: PieceAction[]; raw: string; error?: string } {
  try {
    // Strip markdown code fences if present
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    // Try to find JSON object in the text
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return { actions: [], raw, error: 'No JSON found in response' };
    }

    const jsonStr = text.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonStr) as TerritoryWarResponse;

    if (!parsed.actions || !Array.isArray(parsed.actions)) {
      return { actions: [], raw, error: 'Response missing actions array' };
    }

    // Normalize field names (snake_case from AI → camelCase for our types)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: PieceAction[] = parsed.actions.map((a: any) => ({
      unitId: (a.unit_id ?? a.unitId) as number,
      action: a.action as PieceAction['action'],
      direction: (a.direction ?? null) as PieceAction['direction'],
      targetId: (a.target_id ?? a.targetId ?? null) as number | null,
      targetX: (a.target_x ?? a.targetX ?? null) as number | null,
      targetY: (a.target_y ?? a.targetY ?? null) as number | null,
      reasoning: ((a.reasoning ?? '') as string).slice(0, 300),
    }));

    return { actions, raw };
  } catch (err) {
    return { actions: [], raw, error: `JSON parse error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

// --- Scripted events ---

function applyScriptedEvents(state: GameState): void {
  if (state.tick === RESOURCE_REVEAL_TICK) {
    // Place a large ore deposit at the grid center
    const center = Math.floor(GRID_SIZE / 2);
    const half = Math.floor(RESOURCE_REVEAL_SIZE / 2);

    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = center + dx;
        const y = center + dy;
        if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
          const tile = state.grid[y][x];
          if (tile.tileType === 'empty' || tile.tileType === 'ore' || tile.tileType === 'food') {
            tile.tileType = 'ore';
            tile.resourceAmount = RESOURCE_REVEAL_AMOUNT;
          }
        }
      }
    }

    state.eventLog.push({
      tick: state.tick,
      type: 'resource_reveal',
      model: 'system',
      message: `A massive ore deposit has been revealed at the center of the map!`,
      data: { x: center, y: center, size: RESOURCE_REVEAL_SIZE, amount: RESOURCE_REVEAL_AMOUNT },
    });
  }
}

// --- Rate limiting (reuse the same pattern as debates) ---

const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 10; // fewer than debates — games are long-running
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
  // Rate limit
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests.' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Auth
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  const sessionId = request.headers.get('x-session-id');

  if (!user && !sessionId) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Token balance check
  const { data: balance } = await supabase.rpc('get_token_balance', {
    p_user_id: user?.id ?? null,
    p_session_id: user ? null : sessionId,
  });

  const GAME_COST = 10; // tokens per game

  if ((balance ?? 0) < GAME_COST) {
    return new Response(JSON.stringify({ error: 'Insufficient tokens' }), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse request
  const body: GameRequest = await request.json();
  const { models: modelIds } = body;

  if (!modelIds || modelIds.length < 2 || modelIds.length > 4) {
    return new Response(JSON.stringify({ error: '2-4 models required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Resolve models
  const modelDefs: ModelDefinition[] = [];
  const modelNames: string[] = [];
  for (const id of modelIds) {
    const def = findModel(id);
    if (!def) {
      return new Response(JSON.stringify({ error: `Unknown model: ${id}` }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (def.family === 'user') {
      return new Response(JSON.stringify({ error: 'Human players not supported yet' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    // Premium gating for anonymous users
    if (!user && def.tier === 'premium') {
      return new Response(JSON.stringify({
        error: `${def.name} is only available to signed-in users.`,
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    modelDefs.push(def);
    modelNames.push(def.name);
  }

  // Deduct tokens upfront
  const deductRpc = user
    ? supabase.rpc('deduct_user_tokens', { p_user_id: user.id, p_amount: GAME_COST })
    : supabase.rpc('deduct_session_tokens', { p_session_id: sessionId, p_amount: GAME_COST });
  const { data: deducted, error: deductErr } = await deductRpc;
  if (deductErr || deducted !== true) {
    return new Response(JSON.stringify({ error: 'Insufficient tokens' }), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Create game state
  const gameState = createGame(modelNames);

  // Create DB record
  const { data: gameRow, error: insertErr } = await supabase
    .from('games')
    .insert({
      challenge: 'territory_war',
      creator_user_id: user?.id || null,
      creator_session_id: sessionId || null,
      models: modelIds,
      config: {},
      game_state: gameState as unknown as Record<string, unknown>,
      status: 'running',
      expires_at: user ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (insertErr || !gameRow) {
    console.error('[GAME] Insert error:', insertErr);
    return new Response(JSON.stringify({ error: 'Failed to create game' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const gameId = gameRow.id;

  // Stream the game via SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Emit initial state
        controller.enqueue(encoder.encode(sseEvent('game_started', {
          gameId,
          state: gameState,
          models: modelNames,
        })));

        // Game loop
        while (!gameState.finished) {
          // Apply scripted events BEFORE model turns
          applyScriptedEvents(gameState);

          // Sequential turns: each model acts, others see the result
          for (let mi = 0; mi < modelDefs.length; mi++) {
            const modelDef = modelDefs[mi];
            const modelName = modelNames[mi];

            // Skip eliminated models
            if (gameState.models[modelName]?.eliminated) continue;

            // Signal: model is thinking
            controller.enqueue(encoder.encode(sseEvent('turn_start', {
              tick: gameState.tick,
              model: modelName,
              modelId: modelIds[mi],
            })));

            // Build prompts
            const systemPrompt = buildSystemPrompt(modelName);
            const userPrompt = buildTurnPrompt(gameState, modelName);

            // Call the model
            const result = await callModel(modelDef, systemPrompt, userPrompt);

            // Apply actions
            const events = applyActions(gameState, modelName, result.actions);

            // Emit the model's turn
            controller.enqueue(encoder.encode(sseEvent('turn_actions', {
              tick: gameState.tick,
              model: modelName,
              modelId: modelIds[mi],
              actions: result.actions,
              events,
              error: result.error || null,
            })));
          }

          // Advance tick (territory update, win check)
          const winResult = advanceTick(gameState);

          // Store this turn
          await supabase.from('game_turns').insert({
            game_id: gameId,
            turn_number: gameState.tick,
            game_state: gameState as unknown as Record<string, unknown>,
            model_responses: {},
            events: gameState.eventLog.slice(-20),
          });

          // Update the game row with latest state
          await supabase.from('games').update({
            game_state: gameState as unknown as Record<string, unknown>,
            total_turns: gameState.tick,
            ...(winResult.finished ? {
              status: 'complete',
              winner: winResult.winner,
              finished_at: new Date().toISOString(),
            } : {}),
          }).eq('id', gameId);

          // Emit tick complete
          controller.enqueue(encoder.encode(sseEvent('tick_complete', {
            tick: gameState.tick,
            finished: gameState.finished,
          })));

          if (gameState.finished) {
            controller.enqueue(encoder.encode(sseEvent('game_over', {
              winner: gameState.winner,
              tick: gameState.tick,
              reason: winResult.reason,
            })));
          }
        }
      } catch (err) {
        console.error('[GAME] Stream error:', err);
        const message = err instanceof Error ? err.message : 'Internal error';

        // Mark game as errored
        await supabase.from('games').update({
          status: 'error',
          game_state: gameState as unknown as Record<string, unknown>,
        }).eq('id', gameId);

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
