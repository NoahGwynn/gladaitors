// ============================================================================
// Territory War — State Initialization
// ============================================================================
// Creates a fresh game state: empty grid, random resource placement,
// model spawning at corner positions with initial territory claims.
//
// Ported from backend/game_engine/territory_war.py:
//   TerritoryWarState.__init__(), spawn_model(), init_grid()
// ============================================================================

import {
  GRID_SIZE,
  PIECES_PER_MODEL,
  PIECE_HP,
  PIECE_ATTACK,
  ORE_TILE_COUNT,
  FOOD_TILE_COUNT,
  ORE_PER_TILE_RANGE,
  FOOD_PER_TILE_RANGE,
  MAX_TICKS,
  SPAWN_CORNERS,
} from './constants';
import type { Tile, Piece, ModelState, GameState, TileType } from './types';

// --- Helpers ---

/** Random integer in [min, max] (inclusive). */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Create a single tile. */
function makeTile(x: number, y: number, tileType: TileType = 'empty'): Tile {
  return {
    x,
    y,
    tileType,
    owner: null,
    resourceAmount: 0,
    fortHp: 0,
  };
}

// --- Grid ---

/** Create an empty GRID_SIZE × GRID_SIZE grid. */
function createEmptyGrid(): Tile[][] {
  const grid: Tile[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      row.push(makeTile(x, y));
    }
    grid.push(row);
  }
  return grid;
}

/** Place resource tiles randomly on the grid, avoiding tiles that are
 *  already occupied (bases, other resources). */
function placeResources(grid: Tile[][]): void {
  const placeType = (
    tileType: 'ore' | 'food',
    count: number,
    amountRange: [number, number],
  ) => {
    let placed = 0;
    // Safety cap to prevent infinite loop if the grid is too full
    let attempts = 0;
    while (placed < count && attempts < count * 10) {
      attempts++;
      const x = randInt(0, GRID_SIZE - 1);
      const y = randInt(0, GRID_SIZE - 1);
      const tile = grid[y][x];
      if (tile.tileType !== 'empty') continue;
      tile.tileType = tileType;
      tile.resourceAmount = randInt(amountRange[0], amountRange[1]);
      placed++;
    }
  };

  placeType('ore', ORE_TILE_COUNT, ORE_PER_TILE_RANGE);
  placeType('food', FOOD_TILE_COUNT, FOOD_PER_TILE_RANGE);
}

// --- Model spawning ---

/** Spawn a model at a corner position: place a base tile, claim a 3×3
 *  area around it, and create starting pieces offset toward the center. */
function spawnModel(
  grid: Tile[][],
  modelName: string,
  corner: { x: number; y: number },
  startPieceId: number,
): { pieces: Piece[]; modelState: ModelState; nextPieceId: number } {
  const { x: bx, y: by } = corner;

  // Place the base tile
  grid[by][bx].tileType = 'base';
  grid[by][bx].owner = modelName;

  // Claim 3×3 area around base
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = bx + dx;
      const ny = by + dy;
      if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
        grid[ny][nx].owner = modelName;
      }
    }
  }

  // Determine piece spawn direction (toward center)
  const centerX = Math.floor(GRID_SIZE / 2);
  const centerY = Math.floor(GRID_SIZE / 2);
  const dirX = bx < centerX ? 1 : -1;
  const dirY = by < centerY ? 1 : -1;

  // Create pieces offset from base toward center
  const pieces: Piece[] = [];
  let pieceId = startPieceId;
  for (let i = 0; i < PIECES_PER_MODEL; i++) {
    // Offset pattern: (1,0), (0,1), (1,1) relative to base in the
    // direction of center. Ensures pieces don't stack on the base tile.
    const offsets = [
      { dx: dirX, dy: 0 },
      { dx: 0, dy: dirY },
      { dx: dirX, dy: dirY },
    ];
    const off = offsets[i];
    const px = bx + off.dx;
    const py = by + off.dy;

    pieces.push({
      id: pieceId++,
      modelName,
      x: px,
      y: py,
      hp: PIECE_HP,
      attack: PIECE_ATTACK,
    });
  }

  const modelState: ModelState = {
    name: modelName,
    ore: 0,
    food: 0,
    baseX: bx,
    baseY: by,
    eliminated: false,
  };

  return { pieces, modelState, nextPieceId: pieceId };
}

// --- Public API ---

/** Create a new Territory War game with the given model names.
 *  Supports 2-4 models. Models are assigned to corners in clockwise
 *  order: TL(1,1) → TR(28,1) → BR(28,28) → BL(1,28). */
export function createGame(modelNames: string[]): GameState {
  if (modelNames.length < 2 || modelNames.length > 4) {
    throw new Error(`Territory War requires 2-4 models, got ${modelNames.length}`);
  }

  const grid = createEmptyGrid();
  const allPieces: Piece[] = [];
  const models: Record<string, ModelState> = {};
  let nextPieceId = 1;

  // Spawn each model at a corner
  for (let i = 0; i < modelNames.length; i++) {
    const name = modelNames[i];
    const corner = SPAWN_CORNERS[i];
    const result = spawnModel(grid, name, corner, nextPieceId);
    allPieces.push(...result.pieces);
    models[name] = result.modelState;
    nextPieceId = result.nextPieceId;
  }

  // Place resources AFTER spawning so resources don't land on bases
  placeResources(grid);

  return {
    tick: 0,
    maxTicks: MAX_TICKS,
    grid,
    pieces: allPieces,
    models,
    eventLog: [],
    finished: false,
    winner: null,
    nextPieceId,
  };
}
