// ============================================================================
// Territory War — Type Definitions
// ============================================================================
// All interfaces for the game state, actions, and events. These types are
// the contract between the state machine, the action resolver, the scoring
// engine, the prompt builder, and the API route.
//
// Ported from backend/game_engine/territory_war.py (Python dataclasses →
// TypeScript interfaces).
// ============================================================================

import type { Direction } from './constants';

// --- Tile ---

export type TileType = 'empty' | 'ore' | 'food' | 'base' | 'fort';

export interface Tile {
  x: number;
  y: number;
  tileType: TileType;
  /** Model name that controls this tile, or null if unclaimed. */
  owner: string | null;
  /** Remaining resource yield. 0 = depleted / not a resource tile. */
  resourceAmount: number;
  /** Fort HP. 0 = no fort or fort destroyed. Only meaningful when tileType === 'fort'. */
  fortHp: number;
}

// --- Piece ---

export interface Piece {
  /** Unique ID within this game (auto-incrementing). */
  id: number;
  /** Which model owns this piece. */
  modelName: string;
  x: number;
  y: number;
  /** Current HP. Piece is dead when <= 0 (removed from state). */
  hp: number;
  /** Damage dealt per attack action. Always PIECE_ATTACK (1). */
  attack: number;
}

// --- Model state ---

export interface ModelState {
  name: string;
  ore: number;
  food: number;
  baseX: number;
  baseY: number;
  /** True when all of this model's pieces have been killed. */
  eliminated: boolean;
}

// --- Full game state ---

export interface ChallengeState {
  tick: number;
  maxTicks: number;
  /** 30×30 grid. Access as grid[y][x]. */
  grid: Tile[][];
  /** Alive pieces only. Pieces with hp <= 0 are removed. */
  pieces: Piece[];
  /** Keyed by model name. */
  models: Record<string, ModelState>;
  /** Chronological event log for the current game. */
  eventLog: ChallengeEvent[];
  finished: boolean;
  winner: string | null;
  /** Auto-incrementing counter for piece IDs. */
  nextPieceId: number;
}

// --- Actions ---

export type ActionType = 'move' | 'attack' | 'harvest' | 'build' | 'heal';

export interface PieceAction {
  /** ID of the piece performing the action. */
  unitId: number;
  action: ActionType;
  /** Required for 'move'. */
  direction?: Direction | null;
  /** Target piece ID for 'attack' (piece). */
  targetId?: number | null;
  /** Target tile coordinates for 'attack' (fort) or 'build'. */
  targetX?: number | null;
  targetY?: number | null;
  /** Model's reasoning for this action (max 300 chars, included in prompts). */
  reasoning?: string;
}

/** The JSON response schema the AI model must return. */
export interface TerritoryWarResponse {
  actions: PieceAction[];
}

// --- Events ---

export type ChallengeEventType =
  | 'move'
  | 'attack'
  | 'kill'
  | 'eliminate'
  | 'harvest'
  | 'build'
  | 'heal'
  | 'fort_destroyed'
  | 'territory_claimed'
  | 'invalid_action'
  | 'resource_reveal'
  | 'challenge_complete';

export interface ChallengeEvent {
  tick: number;
  type: ChallengeEventType;
  model: string;
  /** Human-readable description of the event. */
  message: string;
  /** Optional structured data for rendering. */
  data?: Record<string, unknown>;
}

// --- Win condition result ---

export interface WinResult {
  finished: boolean;
  winner: string | null;
  reason: 'score_threshold' | 'last_survivor' | 'time_up' | null;
}

// --- Territory score ---

export interface TerritoryScore {
  /** Number of tiles owned by this model. */
  tiles: number;
  /** Score: 1 per regular tile + 2 per fort-protected tile. */
  score: number;
}
