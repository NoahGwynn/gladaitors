// ============================================================================
// Territory War — Prompt Builders
// ============================================================================
// Builds the system prompt (static game rules) and the per-turn user
// prompt (dynamic game state) for each AI model.
//
// Ported from:
//   backend/ai_adapter/prompts/territory_war_system.txt
//   backend/ai_adapter/prompts/territory_war.txt
//   backend/ai_adapter/adapter.py (build_territory_war_prompts)
//
// The prompt text must produce IDENTICAL output to the Python versions
// so model behavior stays consistent across the migration.
// ============================================================================

import {
  GRID_SIZE,
  PIECE_HP,
  PIECE_ATTACK,
  PIECES_PER_MODEL,
  HARVEST_AMOUNT,
  FORT_COST,
  FORT_HP,
  HEAL_COST,
  HEAL_AMOUNT,
  MAX_TICKS,
  TOTAL_TILES,
  WIN_SCORE_TILES,
} from './constants';
import { calculateAllScores } from './scoring';
import type { ChallengeState } from './types';

// --- System prompt ---

/** Build the static system prompt for a given model. This contains all
 *  the game rules, action schema, and scoring — everything the model
 *  needs to understand the game. Doesn't change between turns. */
export function buildSystemPrompt(modelName: string): string {
  const gridMax = GRID_SIZE - 1;

  return `You are ${modelName} in a territory control game on a ${GRID_SIZE}x${GRID_SIZE} grid (${TOTAL_TILES} tiles). You must make moves that give you the best chance of winning the game.

WIN CONDITIONS (first to occur):
- Reach ${WIN_SCORE_TILES}+ territory score
- Eliminate all enemy pieces (reduce to 0 HP)
- Highest territory score at round ${MAX_TICKS}

SCORING:
- Each tile you control = 1 point
- Fort-protected tiles = 2 points each
- A fort in open space protects 9 tiles = 18 points

GRID:
- Coordinates: (0,0) is top-left, (${gridMax},${gridMax}) is bottom-right
- Directions: up = y-1, down = y+1, left = x-1, right = x+1
- Invalid moves (off the edge) result in no movement

RULES:

Territory claiming:
- Your pieces claim the tile they stand on for you
- You can claim tiles currently owned by enemies

Pieces:
- Each piece has ${PIECE_HP} HP and ${PIECE_ATTACK} attack
- You start with ${PIECES_PER_MODEL} pieces

Combat:
- You can attack adjacent enemy pieces (within 1 tile in any direction)
- Each attack deals ${PIECE_ATTACK} damage
- It takes ${PIECE_HP} hits to kill a full-health piece

Elimination:
- When all of a model's pieces are killed, that model is eliminated

Harvesting:
- Pieces on resource tiles can harvest up to ${HARVEST_AMOUNT} resources per action
- Harvesting depletes the tile's resources

Ore:
- Used to build forts (costs ${FORT_COST} ore)

Food:
- Used to heal pieces (costs ${HEAL_COST} food, restores ${HEAL_AMOUNT} HP, max ${PIECE_HP} HP)

Forts:
- Can only be built on empty tiles (not resource tiles, not other forts)
- Building a fort immediately claims the tile and all 8 neighbouring tiles for you, even if they were unclaimed or owned by an enemy (unless they contain a base or another fort)
- While a fort stands, enemies cannot reclaim any of the 9 tiles (the fort tile + 8 surrounding) by moving through them
- Protected tiles count as 2 points each in the territory score
- Forts have ${FORT_HP} HP
- Enemies can attack forts by specifying target_x and target_y coordinates
- When a fort is destroyed (0 HP), its protection is removed and enemies can claim those tiles again

ACTIONS (up to 3 per turn, one per piece):
- move: move a piece in a direction (up/down/left/right)
- attack: attack an adjacent enemy piece (requires target_id) or fort (requires target_x, target_y)
- harvest: gather resources from the current tile
- build: build a fort on the current tile (costs 10 ore)
- heal: heal this piece (costs 5 food, restores 1 HP up to max 3)

Respond ONLY with valid JSON matching this schema:
{
  "actions": [
    {
      "unit_id": <int>,
      "action": "move" | "attack" | "harvest" | "build" | "heal",
      "direction": "up" | "down" | "left" | "right",
      "target_id": <int or null>,
      "target_x": <int or null>,
      "target_y": <int or null>,
      "reasoning": "<your reasoning>"
    }
  ]
}

Note: "unit_id" field refers to piece ID. Only include fields relevant to the action. Maximum 3 actions per turn.`;
}

// --- Turn prompt ---

/** Build the per-turn user prompt for a given model. Contains the
 *  current game state from that model's perspective: territory,
 *  pieces, resources, and recent events. */
export function buildTurnPrompt(state: ChallengeState, modelName: string): string {
  const model = state.models[modelName];
  if (!model) throw new Error(`Model "${modelName}" not found in game state`);

  // Territory scores
  const scores = calculateAllScores(state);
  const territoryScore: Record<string, number> = {};
  const territoryCounts: Record<string, number> = {};
  for (const [name, s] of Object.entries(scores)) {
    territoryScore[name] = s.score;
    territoryCounts[name] = s.tiles;
  }

  // My territory vs enemy territory (tile coordinates)
  const myTerritory: { x: number; y: number }[] = [];
  const enemyTerritory: Record<string, { x: number; y: number }[]> = {};

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const owner = state.grid[y][x].owner;
      if (owner === modelName) {
        myTerritory.push({ x, y });
      } else if (owner && owner !== modelName) {
        if (!enemyTerritory[owner]) enemyTerritory[owner] = [];
        enemyTerritory[owner].push({ x, y });
      }
    }
  }

  // Pieces
  const myUnits = state.pieces
    .filter(p => p.modelName === modelName)
    .map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      hp: p.hp,
      attack: p.attack,
      model: p.modelName,
    }));

  const enemyUnits = state.pieces
    .filter(p => p.modelName !== modelName)
    .map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      hp: p.hp,
      attack: p.attack,
      model: p.modelName,
    }));

  // Resources
  const myResources = { ore: model.ore, food: model.food };

  // Resource tiles on the map
  const resourceTiles: { type: string; x: number; y: number; resources: number }[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const tile = state.grid[y][x];
      if (tile.tileType === 'ore' || tile.tileType === 'food') {
        resourceTiles.push({
          type: tile.tileType,
          x: tile.x,
          y: tile.y,
          resources: tile.resourceAmount,
        });
      }
    }
  }

  // Recent events (last 10)
  const recentEvents = state.eventLog.slice(-10).map(e => ({
    tick: e.tick,
    type: e.type,
    model: e.model,
    message: e.message,
  }));

  return `Turn ${state.tick + 1} of ${state.maxTicks}.

Territory scores: ${JSON.stringify(territoryScore)}
Territory tile counts: ${JSON.stringify(territoryCounts)}

Tiles you control: ${JSON.stringify(myTerritory)}

Tiles controlled by enemies: ${JSON.stringify(enemyTerritory)}

Your pieces:
${JSON.stringify(myUnits, null, 2)}

Enemy pieces:
${JSON.stringify(enemyUnits, null, 2)}

Your resources: ${JSON.stringify(myResources)}

Resource tiles on the map:
${JSON.stringify(resourceTiles, null, 2)}

Recent events:
${JSON.stringify(recentEvents, null, 2)}

Respond with your actions as JSON.`;
}

// --- Combined prompt builder for all models ---

export interface ModelPrompts {
  system: string;
  user: string;
}

/** Build prompts for all non-eliminated models in the game.
 *  Returns a map of modelName → { system, user }. */
export function buildAllPrompts(state: ChallengeState): Record<string, ModelPrompts> {
  const prompts: Record<string, ModelPrompts> = {};

  for (const modelName of Object.keys(state.models)) {
    if (state.models[modelName].eliminated) continue;

    prompts[modelName] = {
      system: buildSystemPrompt(modelName),
      user: buildTurnPrompt(state, modelName),
    };
  }

  return prompts;
}
