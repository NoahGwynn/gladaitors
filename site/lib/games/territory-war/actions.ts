// ============================================================================
// Territory War — Action Validation & Resolution
// ============================================================================
// The core game logic. Each action is validated against the rules, applied
// to the state, and an event is generated. Invalid actions are logged but
// don't crash the game — the turn simply skips that action.
//
// Ported from backend/game_engine/territory_war.py:
//   apply_actions(), _resolve_move(), _resolve_attack(), etc.
// ============================================================================

import {
  GRID_SIZE,
  PIECE_ATTACK,
  PIECE_HP,
  HARVEST_AMOUNT,
  FORT_COST,
  FORT_HP,
  HEAL_COST,
  HEAL_AMOUNT,
  MAX_ACTIONS_PER_TURN,
  DIRECTIONS,
} from './constants';
import type {
  GameState,
  Piece,
  Tile,
  PieceAction,
  GameEvent,
} from './types';

// --- Helpers ---

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

/** Check if two positions are adjacent (including diagonals). */
function isAdjacent(x1: number, y1: number, x2: number, y2: number): boolean {
  return Math.abs(x1 - x2) <= 1 && Math.abs(y1 - y2) <= 1 && !(x1 === x2 && y1 === y2);
}

function findPiece(state: GameState, id: number): Piece | undefined {
  return state.pieces.find(p => p.id === id);
}

function addEvent(
  state: GameState,
  type: GameEvent['type'],
  model: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  state.eventLog.push({ tick: state.tick, type, model, message, data });
}

// --- Individual action resolvers ---

function resolveMove(state: GameState, piece: Piece, action: PieceAction): void {
  if (!action.direction || !(action.direction in DIRECTIONS)) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: invalid move direction "${action.direction}"`);
    return;
  }

  const dir = DIRECTIONS[action.direction];
  const nx = piece.x + dir.dx;
  const ny = piece.y + dir.dy;

  if (!inBounds(nx, ny)) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: move ${action.direction} out of bounds`);
    return;
  }

  piece.x = nx;
  piece.y = ny;

  addEvent(state, 'move', piece.modelName,
    `Piece ${piece.id} moved ${action.direction} to (${nx},${ny})`,
    { pieceId: piece.id, x: nx, y: ny, direction: action.direction });
}

function resolveAttackPiece(state: GameState, piece: Piece, action: PieceAction): void {
  if (action.targetId == null) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: attack requires target_id`);
    return;
  }

  const target = findPiece(state, action.targetId);
  if (!target) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: target piece ${action.targetId} not found`);
    return;
  }

  if (target.modelName === piece.modelName) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: cannot attack own piece ${target.id}`);
    return;
  }

  if (!isAdjacent(piece.x, piece.y, target.x, target.y)) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: target ${target.id} at (${target.x},${target.y}) not adjacent`);
    return;
  }

  target.hp -= PIECE_ATTACK;

  addEvent(state, 'attack', piece.modelName,
    `Piece ${piece.id} attacked piece ${target.id} for ${PIECE_ATTACK} damage (${target.hp} HP remaining)`,
    { attackerId: piece.id, targetId: target.id, damage: PIECE_ATTACK, targetHp: target.hp });

  if (target.hp <= 0) {
    addEvent(state, 'kill', piece.modelName,
      `Piece ${piece.id} killed piece ${target.id} (${target.modelName})`,
      { killerId: piece.id, killedId: target.id, killedModel: target.modelName });

    // Check if the target's model is eliminated (no pieces left)
    const remainingPieces = state.pieces.filter(
      p => p.modelName === target.modelName && p.id !== target.id && p.hp > 0
    );
    if (remainingPieces.length === 0) {
      const targetModel = state.models[target.modelName];
      if (targetModel) {
        targetModel.eliminated = true;
        addEvent(state, 'eliminate', piece.modelName,
          `${target.modelName} has been eliminated!`,
          { eliminatedModel: target.modelName });
      }
    }
  }
}

function resolveAttackFort(state: GameState, piece: Piece, action: PieceAction): void {
  if (action.targetX == null || action.targetY == null) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: fort attack requires target_x and target_y`);
    return;
  }

  const { targetX, targetY } = action;

  if (!inBounds(targetX, targetY)) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: fort target (${targetX},${targetY}) out of bounds`);
    return;
  }

  if (!isAdjacent(piece.x, piece.y, targetX, targetY)) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: fort at (${targetX},${targetY}) not adjacent`);
    return;
  }

  const tile = state.grid[targetY][targetX];

  if (tile.tileType !== 'fort') {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: tile (${targetX},${targetY}) is not a fort`);
    return;
  }

  if (tile.owner === piece.modelName) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: cannot attack own fort at (${targetX},${targetY})`);
    return;
  }

  tile.fortHp -= PIECE_ATTACK;

  addEvent(state, 'attack', piece.modelName,
    `Piece ${piece.id} attacked fort at (${targetX},${targetY}) for ${PIECE_ATTACK} damage (${tile.fortHp} HP remaining)`,
    { attackerId: piece.id, targetX, targetY, damage: PIECE_ATTACK, fortHp: tile.fortHp });

  if (tile.fortHp <= 0) {
    tile.tileType = 'empty';
    tile.fortHp = 0;
    tile.owner = null;

    addEvent(state, 'fort_destroyed', piece.modelName,
      `Fort at (${targetX},${targetY}) destroyed by piece ${piece.id}`,
      { x: targetX, y: targetY, destroyedBy: piece.id });
  }
}

function resolveAttack(state: GameState, piece: Piece, action: PieceAction): void {
  // Determine if this is a piece attack or fort attack based on which
  // target fields are provided.
  if (action.targetId != null) {
    resolveAttackPiece(state, piece, action);
  } else if (action.targetX != null && action.targetY != null) {
    resolveAttackFort(state, piece, action);
  } else {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: attack requires either target_id or target_x/target_y`);
  }
}

function resolveHarvest(state: GameState, piece: Piece): void {
  const tile = state.grid[piece.y][piece.x];

  if (tile.tileType !== 'ore' && tile.tileType !== 'food') {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: no resource to harvest at (${piece.x},${piece.y})`);
    return;
  }

  const amount = Math.min(tile.resourceAmount, HARVEST_AMOUNT);
  if (amount <= 0) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: resource at (${piece.x},${piece.y}) is depleted`);
    return;
  }

  const model = state.models[piece.modelName];
  if (tile.tileType === 'ore') {
    model.ore += amount;
  } else {
    model.food += amount;
  }
  tile.resourceAmount -= amount;

  addEvent(state, 'harvest', piece.modelName,
    `Piece ${piece.id} harvested ${amount} ${tile.tileType} at (${piece.x},${piece.y}) (${tile.resourceAmount} remaining)`,
    { pieceId: piece.id, resource: tile.tileType, amount, remaining: tile.resourceAmount });

  // Deplete tile if empty
  if (tile.resourceAmount <= 0) {
    tile.tileType = 'empty';
    tile.resourceAmount = 0;
  }
}

function resolveBuild(state: GameState, piece: Piece): void {
  const model = state.models[piece.modelName];

  if (model.ore < FORT_COST) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: not enough ore to build (have ${model.ore}, need ${FORT_COST})`);
    return;
  }

  const tile = state.grid[piece.y][piece.x];
  if (tile.tileType !== 'empty') {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: can only build on empty tiles (tile is ${tile.tileType})`);
    return;
  }

  // Deduct cost and build
  model.ore -= FORT_COST;
  tile.tileType = 'fort';
  tile.fortHp = FORT_HP;
  tile.owner = piece.modelName;

  addEvent(state, 'build', piece.modelName,
    `Piece ${piece.id} built a fort at (${piece.x},${piece.y})`,
    { pieceId: piece.id, x: piece.x, y: piece.y });

  // Claim all 8 neighboring tiles (except base/fort tiles)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = piece.x + dx;
      const ny = piece.y + dy;
      if (!inBounds(nx, ny)) continue;
      const neighbor = state.grid[ny][nx];
      if (neighbor.tileType === 'base' || neighbor.tileType === 'fort') continue;
      neighbor.owner = piece.modelName;
    }
  }
}

function resolveHeal(state: GameState, piece: Piece): void {
  const model = state.models[piece.modelName];

  if (piece.hp >= PIECE_HP) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: already at full HP (${piece.hp}/${PIECE_HP})`);
    return;
  }

  if (model.food < HEAL_COST) {
    addEvent(state, 'invalid_action', piece.modelName,
      `Piece ${piece.id}: not enough food to heal (have ${model.food}, need ${HEAL_COST})`);
    return;
  }

  model.food -= HEAL_COST;
  piece.hp = Math.min(piece.hp + HEAL_AMOUNT, PIECE_HP);

  addEvent(state, 'heal', piece.modelName,
    `Piece ${piece.id} healed to ${piece.hp} HP`,
    { pieceId: piece.id, hp: piece.hp });
}

// --- Main entry point ---

/** Apply a list of actions from a single model to the game state.
 *  Actions are validated and resolved in order. Invalid actions are
 *  logged as events but don't crash the game.
 *
 *  Mutates `state` in place and returns the list of events generated. */
export function applyActions(
  state: GameState,
  modelName: string,
  actions: PieceAction[],
): GameEvent[] {
  const startEventCount = state.eventLog.length;

  // Cap at MAX_ACTIONS_PER_TURN
  const capped = actions.slice(0, MAX_ACTIONS_PER_TURN);

  for (const action of capped) {
    const piece = findPiece(state, action.unitId);

    if (!piece) {
      addEvent(state, 'invalid_action', modelName,
        `Piece ${action.unitId} not found`);
      continue;
    }

    if (piece.modelName !== modelName) {
      addEvent(state, 'invalid_action', modelName,
        `Piece ${action.unitId} belongs to ${piece.modelName}, not ${modelName}`);
      continue;
    }

    if (piece.hp <= 0) {
      addEvent(state, 'invalid_action', modelName,
        `Piece ${action.unitId} is dead`);
      continue;
    }

    switch (action.action) {
      case 'move':
        resolveMove(state, piece, action);
        break;
      case 'attack':
        resolveAttack(state, piece, action);
        break;
      case 'harvest':
        resolveHarvest(state, piece);
        break;
      case 'build':
        resolveBuild(state, piece);
        break;
      case 'heal':
        resolveHeal(state, piece);
        break;
      default:
        addEvent(state, 'invalid_action', modelName,
          `Piece ${action.unitId}: unknown action "${action.action}"`);
    }
  }

  // Remove dead pieces (hp <= 0) after all actions resolve
  state.pieces = state.pieces.filter(p => p.hp > 0);

  return state.eventLog.slice(startEventCount);
}
