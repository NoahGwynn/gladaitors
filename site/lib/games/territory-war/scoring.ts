// ============================================================================
// Territory War — Scoring & Win Conditions
// ============================================================================
// Territory calculation, score computation, and end-game detection.
//
// Ported from backend/game_engine/territory_war.py:
//   calculate_territory(), calculate_score(), check_end_conditions()
// ============================================================================

import { GRID_SIZE, WIN_SCORE_TILES } from './constants';
import type {
  GameState,
  Tile,
  TerritoryScore,
  WinResult,
  GameEvent,
} from './types';

// --- Helpers ---

/** Check if a tile is protected by a fort owned by `modelName`.
 *  A tile is fort-protected if it's within 1 tile (8-neighbor radius)
 *  of a fort owned by the same model with hp > 0. */
function isFortProtected(grid: Tile[][], x: number, y: number, modelName: string): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const neighbor = grid[ny][nx];
      if (neighbor.tileType === 'fort' && neighbor.owner === modelName && neighbor.fortHp > 0) {
        return true;
      }
    }
  }
  return false;
}

/** Check if a tile is protected by an ENEMY fort (i.e., the claiming
 *  model cannot claim this tile because an enemy fort is nearby). */
function isEnemyFortProtected(grid: Tile[][], x: number, y: number, modelName: string): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const neighbor = grid[ny][nx];
      if (
        neighbor.tileType === 'fort' &&
        neighbor.owner !== modelName &&
        neighbor.owner !== null &&
        neighbor.fortHp > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

// --- Public API ---

/** Update territory ownership: each alive piece claims the tile it
 *  stands on for its model. Tiles protected by enemy forts cannot be
 *  claimed. Base tiles cannot be claimed by enemies.
 *
 *  Mutates `state.grid` in place. */
export function updateTerritory(state: GameState): void {
  for (const piece of state.pieces) {
    if (piece.hp <= 0) continue;
    const tile = state.grid[piece.y][piece.x];

    // Base tiles cannot be claimed by non-owners
    if (tile.tileType === 'base' && tile.owner !== piece.modelName) continue;

    // Cannot claim tiles protected by enemy forts
    if (isEnemyFortProtected(state.grid, piece.x, piece.y, piece.modelName)) continue;

    tile.owner = piece.modelName;
  }
}

/** Calculate the territory score for a single model.
 *  - Regular owned tile: 1 point
 *  - Fort-protected owned tile: 2 points */
export function calculateScore(state: GameState, modelName: string): TerritoryScore {
  let tiles = 0;
  let score = 0;

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const tile = state.grid[y][x];
      if (tile.owner === modelName) {
        tiles++;
        if (isFortProtected(state.grid, x, y, modelName)) {
          score += 2;
        } else {
          score += 1;
        }
      }
    }
  }

  return { tiles, score };
}

/** Calculate territory scores for ALL models in the game. */
export function calculateAllScores(state: GameState): Record<string, TerritoryScore> {
  const scores: Record<string, TerritoryScore> = {};
  for (const modelName of Object.keys(state.models)) {
    scores[modelName] = calculateScore(state, modelName);
  }
  return scores;
}

/** Check if the game has ended. Returns null if the game continues.
 *
 *  Win conditions (checked in order):
 *  1. Score threshold: a model's score >= WIN_SCORE_TILES (540)
 *  2. Last survivor: all other models are eliminated
 *  3. Time up: tick >= maxTicks — highest score wins */
export function checkWinCondition(state: GameState): WinResult {
  const modelNames = Object.keys(state.models);

  // 1. Score threshold
  for (const name of modelNames) {
    if (state.models[name].eliminated) continue;
    const { score } = calculateScore(state, name);
    if (score >= WIN_SCORE_TILES) {
      return { finished: true, winner: name, reason: 'score_threshold' };
    }
  }

  // 2. Last survivor
  const alive = modelNames.filter(n => !state.models[n].eliminated);
  if (alive.length === 1) {
    return { finished: true, winner: alive[0], reason: 'last_survivor' };
  }
  if (alive.length === 0) {
    // Edge case: all models eliminated simultaneously
    return { finished: true, winner: null, reason: 'last_survivor' };
  }

  // 3. Time up
  if (state.tick >= state.maxTicks) {
    // Highest score wins
    let bestName: string | null = null;
    let bestScore = -1;
    for (const name of alive) {
      const { score } = calculateScore(state, name);
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    return { finished: true, winner: bestName, reason: 'time_up' };
  }

  return { finished: false, winner: null, reason: null };
}

/** Advance the tick: update territory, remove dead pieces, check win
 *  conditions. Call this AFTER all models have taken their actions
 *  for the current tick.
 *
 *  Mutates `state` in place. Returns the win result. */
export function advanceTick(state: GameState): WinResult {
  state.tick++;

  // Update territory (pieces claim tiles)
  updateTerritory(state);

  // Remove dead pieces (belt-and-braces — applyActions already does this,
  // but scripted events or edge cases might create new deaths)
  state.pieces = state.pieces.filter(p => p.hp > 0);

  // Check win conditions
  const result = checkWinCondition(state);
  if (result.finished) {
    state.finished = true;
    state.winner = result.winner;

    const scores = calculateAllScores(state);
    const scoreStr = Object.entries(scores)
      .map(([name, s]) => `${name}: ${s.score} (${s.tiles} tiles)`)
      .join(', ');

    state.eventLog.push({
      tick: state.tick,
      type: 'game_over',
      model: result.winner || 'none',
      message: `Game over — ${result.reason}. ${result.winner ? `${result.winner} wins!` : 'No winner.'} Scores: ${scoreStr}`,
      data: { reason: result.reason, winner: result.winner, scores },
    });
  }

  return result;
}
