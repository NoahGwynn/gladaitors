// ============================================================================
// Territory War — Game Constants
// ============================================================================
// All numeric constants that define game balance. Changing a value here
// changes it everywhere — state machine, validation, scoring, prompts.
//
// Values are ported from backend/game_engine/territory_war.py and must
// stay in sync until the Python backend is retired.
// ============================================================================

/** Grid dimensions (square). */
export const GRID_SIZE = 30;

/** Total tiles on the grid. */
export const TOTAL_TILES = GRID_SIZE * GRID_SIZE;

// --- Pieces ---

/** Starting pieces per model. */
export const PIECES_PER_MODEL = 3;

/** Maximum pieces a model can have alive at once. */
export const MAX_PIECES_PER_MODEL = 10;

/** Starting and maximum HP for a piece. */
export const PIECE_HP = 3;

/** Damage dealt per attack action. */
export const PIECE_ATTACK = 1;

/** Maximum actions a model can take per turn (across all its pieces). */
export const MAX_ACTIONS_PER_TURN = 3;

// --- Resources ---

/** Number of ore tiles placed during map generation. */
export const ORE_TILE_COUNT = 30;

/** Number of food tiles placed during map generation. */
export const FOOD_TILE_COUNT = 15;

/** Range for random ore amount per tile [min, max] (inclusive). */
export const ORE_PER_TILE_RANGE: [number, number] = [5, 15];

/** Range for random food amount per tile [min, max] (inclusive). */
export const FOOD_PER_TILE_RANGE: [number, number] = [3, 10];

/** Resources harvested per harvest action (capped by tile remainder). */
export const HARVEST_AMOUNT = 3;

// --- Forts ---

/** Ore cost to build a fort. */
export const FORT_COST = 10;

/** Starting HP for a newly built fort. */
export const FORT_HP = 5;

// --- Healing ---

/** Food cost to heal a piece. */
export const HEAL_COST = 5;

/** HP restored per heal action. */
export const HEAL_AMOUNT = 1;

// --- Win conditions ---

/** Fraction of total tiles a model must control to win by score. */
export const WIN_SCORE_THRESHOLD = 0.6;

/** Absolute tile count needed to win by score (TOTAL_TILES × threshold). */
export const WIN_SCORE_TILES = Math.floor(TOTAL_TILES * WIN_SCORE_THRESHOLD);

/** Maximum turns before the game ends by timeout. */
export const MAX_TICKS = 100;

// --- Spawn positions ---
// Corner positions for up to 4 models, in clockwise order:
// Top-left → Top-right → Bottom-right → Bottom-left.

export const SPAWN_CORNERS: readonly { x: number; y: number }[] = [
  { x: 1, y: 1 },   // TL
  { x: 28, y: 1 },  // TR
  { x: 28, y: 28 }, // BR
  { x: 1, y: 28 },  // BL
];

// --- Scripted events ---

/** Turn on which the mid-game resource reveal fires. */
export const RESOURCE_REVEAL_TICK = 42;

/** Size of the revealed resource deposit (N×N area at grid center). */
export const RESOURCE_REVEAL_SIZE = 3;

/** Ore amount placed on each tile of the revealed deposit. */
export const RESOURCE_REVEAL_AMOUNT = 25;

// --- Directions ---

export const DIRECTIONS = {
  up:    { dx: 0, dy: -1 },
  down:  { dx: 0, dy: 1 },
  left:  { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
} as const;

export type Direction = keyof typeof DIRECTIONS;
