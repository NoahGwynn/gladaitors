// ============================================================================
// Territory War — Engine Test Script
// ============================================================================
// Run with: npx tsx site/lib/games/territory-war/test.ts
//
// Tests the core engine in isolation: state creation, all action types,
// scoring, and win conditions. No AI calls, no DB, no network.
// ============================================================================

import { createGame } from './state';
import { applyActions } from './actions';
import { updateTerritory, calculateScore, calculateAllScores, checkWinCondition, advanceTick } from './scoring';
import { GRID_SIZE, PIECE_HP, FORT_COST, FORT_HP, HEAL_COST, PIECE_ATTACK } from './constants';
import type { GameState, PieceAction } from './types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ============================================================================
// 1. State creation
// ============================================================================

section('State creation');

const game = createGame(['Claude', 'GPT', 'Gemini']);

assert(game.grid.length === GRID_SIZE, 'Grid has 30 rows');
assert(game.grid[0].length === GRID_SIZE, 'Grid has 30 columns');
assert(game.pieces.length === 9, `9 pieces spawned (3 models × 3 pieces), got ${game.pieces.length}`);
assert(game.tick === 0, 'Starts at tick 0');
assert(!game.finished, 'Not finished');
assert(game.winner === null, 'No winner');

// Check models exist
assert('Claude' in game.models, 'Claude model exists');
assert('GPT' in game.models, 'GPT model exists');
assert('Gemini' in game.models, 'Gemini model exists');

// Check bases
assert(game.grid[1][1].tileType === 'base', 'Claude base at (1,1)');
assert(game.grid[1][1].owner === 'Claude', 'Claude owns base tile');
assert(game.grid[1][28].tileType === 'base', 'GPT base at (28,1)');
assert(game.grid[28][28].tileType === 'base', 'Gemini base at (28,28)');

// Check pieces belong to correct models
const claudePieces = game.pieces.filter(p => p.modelName === 'Claude');
const gptPieces = game.pieces.filter(p => p.modelName === 'GPT');
const geminiPieces = game.pieces.filter(p => p.modelName === 'Gemini');
assert(claudePieces.length === 3, `Claude has 3 pieces, got ${claudePieces.length}`);
assert(gptPieces.length === 3, `GPT has 3 pieces, got ${gptPieces.length}`);
assert(geminiPieces.length === 3, `Gemini has 3 pieces, got ${geminiPieces.length}`);

// Check all pieces have full HP
assert(game.pieces.every(p => p.hp === PIECE_HP), 'All pieces at full HP');

// Check resources were placed
let oreCount = 0;
let foodCount = 0;
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    if (game.grid[y][x].tileType === 'ore') oreCount++;
    if (game.grid[y][x].tileType === 'food') foodCount++;
  }
}
assert(oreCount > 0, `Ore tiles placed: ${oreCount}`);
assert(foodCount > 0, `Food tiles placed: ${foodCount}`);

// Check 3×3 territory claim around Claude's base
assert(game.grid[0][0].owner === 'Claude', 'Claude claims (0,0) — NW of base');
assert(game.grid[2][2].owner === 'Claude', 'Claude claims (2,2) — SE of base');

// Check 2-model game works
const game2 = createGame(['A', 'B']);
assert(game2.pieces.length === 6, '2-model game has 6 pieces');

// Check 4-model game works
const game4 = createGame(['A', 'B', 'C', 'D']);
assert(game4.pieces.length === 12, '4-model game has 12 pieces');

// Check invalid model count throws
try {
  createGame(['Solo']);
  assert(false, 'Single model should throw');
} catch {
  assert(true, 'Single model throws');
}

// ============================================================================
// 2. Move action
// ============================================================================

section('Move action');

{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  const startX = piece.x;
  const startY = piece.y;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'move', direction: 'right' }]);
  assert(piece.x === startX + 1, `Moved right: x ${startX} → ${piece.x}`);

  applyActions(g, 'A', [{ unitId: piece.id, action: 'move', direction: 'down' }]);
  assert(piece.y === startY + 1, `Moved down: y ${startY} → ${piece.y}`);
}

// Move out of bounds
{
  const g = createGame(['A', 'B']);
  // Find a piece near the edge — Claude's base is at (1,1), pieces near there
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  // Move it to top-left corner
  piece.x = 0;
  piece.y = 0;

  const eventsBefore = g.eventLog.length;
  applyActions(g, 'A', [{ unitId: piece.id, action: 'move', direction: 'up' }]);
  assert(piece.y === 0, 'Out-of-bounds move: piece stays');
  assert(g.eventLog.length > eventsBefore, 'Out-of-bounds move: event logged');
  assert(g.eventLog[g.eventLog.length - 1].type === 'invalid_action', 'Out-of-bounds: invalid_action event');
}

// ============================================================================
// 3. Attack action (piece)
// ============================================================================

section('Attack action (piece)');

{
  const g = createGame(['A', 'B']);
  const attacker = g.pieces.find(p => p.modelName === 'A')!;
  const target = g.pieces.find(p => p.modelName === 'B')!;

  // Move them adjacent
  attacker.x = 5;
  attacker.y = 5;
  target.x = 6;
  target.y = 5;
  const hpBefore = target.hp;

  applyActions(g, 'A', [{ unitId: attacker.id, action: 'attack', targetId: target.id }]);
  assert(target.hp === hpBefore - PIECE_ATTACK, `Attack deals ${PIECE_ATTACK} damage: ${hpBefore} → ${target.hp}`);
}

// Attack non-adjacent should fail
{
  const g = createGame(['A', 'B']);
  const attacker = g.pieces.find(p => p.modelName === 'A')!;
  const target = g.pieces.find(p => p.modelName === 'B')!;

  attacker.x = 5;
  attacker.y = 5;
  target.x = 8;
  target.y = 8;

  const hpBefore = target.hp;
  applyActions(g, 'A', [{ unitId: attacker.id, action: 'attack', targetId: target.id }]);
  assert(target.hp === hpBefore, 'Non-adjacent attack: no damage');
}

// Attack own piece should fail
{
  const g = createGame(['A', 'B']);
  const pieces = g.pieces.filter(p => p.modelName === 'A');
  pieces[0].x = 5;
  pieces[0].y = 5;
  pieces[1].x = 6;
  pieces[1].y = 5;

  const hpBefore = pieces[1].hp;
  applyActions(g, 'A', [{ unitId: pieces[0].id, action: 'attack', targetId: pieces[1].id }]);
  assert(pieces[1].hp === hpBefore, 'Cannot attack own piece');
}

// Kill + elimination
{
  const g = createGame(['A', 'B']);
  const attacker = g.pieces.find(p => p.modelName === 'A')!;

  // Kill all B pieces
  const bPieces = g.pieces.filter(p => p.modelName === 'B');
  for (const bp of bPieces) {
    bp.x = attacker.x + 1;
    bp.y = attacker.y;
    bp.hp = 1; // One hit to kill
    applyActions(g, 'A', [{ unitId: attacker.id, action: 'attack', targetId: bp.id }]);
  }

  assert(g.models['B'].eliminated, 'B is eliminated after all pieces killed');
  assert(g.pieces.filter(p => p.modelName === 'B').length === 0, 'No B pieces remain');
}

// ============================================================================
// 4. Harvest action
// ============================================================================

section('Harvest action');

{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;

  // Place piece on an ore tile
  piece.x = 15;
  piece.y = 15;
  g.grid[15][15].tileType = 'ore';
  g.grid[15][15].resourceAmount = 10;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'harvest' }]);
  assert(g.models['A'].ore === 3, `Harvested 3 ore, got ${g.models['A'].ore}`);
  assert(g.grid[15][15].resourceAmount === 7, `Tile has 7 remaining, got ${g.grid[15][15].resourceAmount}`);
}

// Harvest depletes tile
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 15;
  piece.y = 15;
  g.grid[15][15].tileType = 'food';
  g.grid[15][15].resourceAmount = 2;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'harvest' }]);
  assert(g.models['A'].food === 2, `Harvested 2 food (capped by remainder), got ${g.models['A'].food}`);
  assert(g.grid[15][15].tileType === 'empty', 'Depleted tile becomes empty');
}

// Harvest on empty tile
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 15;
  piece.y = 15;
  g.grid[15][15].tileType = 'empty';

  const eventsBefore = g.eventLog.length;
  applyActions(g, 'A', [{ unitId: piece.id, action: 'harvest' }]);
  assert(g.eventLog.length > eventsBefore, 'Harvest on empty tile: event logged');
}

// ============================================================================
// 5. Build action
// ============================================================================

section('Build action');

{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 10;
  piece.y = 10;
  g.grid[10][10].tileType = 'empty';
  g.grid[10][10].owner = null;
  g.models['A'].ore = FORT_COST;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'build' }]);
  assert(g.grid[10][10].tileType === 'fort', 'Fort built');
  assert(g.grid[10][10].fortHp === FORT_HP, `Fort HP = ${FORT_HP}`);
  assert(g.grid[10][10].owner === 'A', 'Fort owned by A');
  assert(g.models['A'].ore === 0, 'Ore deducted');

  // Check neighbors claimed
  assert(g.grid[9][9].owner === 'A', 'NW neighbor claimed');
  assert(g.grid[9][10].owner === 'A', 'N neighbor claimed');
  assert(g.grid[11][11].owner === 'A', 'SE neighbor claimed');
}

// Build without enough ore
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 10;
  piece.y = 10;
  g.grid[10][10].tileType = 'empty';
  g.models['A'].ore = FORT_COST - 1;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'build' }]);
  assert(g.grid[10][10].tileType === 'empty', 'No fort without enough ore');
}

// Build on non-empty tile
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 10;
  piece.y = 10;
  g.grid[10][10].tileType = 'ore';
  g.grid[10][10].resourceAmount = 5;
  g.models['A'].ore = FORT_COST;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'build' }]);
  assert(g.grid[10][10].tileType === 'ore', 'Cannot build on resource tile');
}

// ============================================================================
// 6. Attack fort
// ============================================================================

section('Attack fort');

{
  const g = createGame(['A', 'B']);
  const attacker = g.pieces.find(p => p.modelName === 'A')!;
  attacker.x = 10;
  attacker.y = 10;

  // Place enemy fort adjacent
  g.grid[10][11].tileType = 'fort';
  g.grid[10][11].fortHp = 2;
  g.grid[10][11].owner = 'B';

  applyActions(g, 'A', [{ unitId: attacker.id, action: 'attack', targetX: 11, targetY: 10 }]);
  assert(g.grid[10][11].fortHp === 1, `Fort took damage: ${g.grid[10][11].fortHp} HP`);

  applyActions(g, 'A', [{ unitId: attacker.id, action: 'attack', targetX: 11, targetY: 10 }]);
  assert(g.grid[10][11].tileType === 'empty', 'Fort destroyed → empty tile');
  assert(g.grid[10][11].fortHp === 0, 'Fort HP = 0');
  assert(g.grid[10][11].owner === null, 'Fort tile unclaimed');
}

// ============================================================================
// 7. Heal action
// ============================================================================

section('Heal action');

{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.hp = 1;
  g.models['A'].food = HEAL_COST;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'heal' }]);
  assert(piece.hp === 2, `Healed: 1 → ${piece.hp}`);
  assert(g.models['A'].food === 0, 'Food deducted');
}

// Heal at full HP
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  g.models['A'].food = HEAL_COST;

  const eventsBefore = g.eventLog.length;
  applyActions(g, 'A', [{ unitId: piece.id, action: 'heal' }]);
  assert(g.eventLog.some(e => e.type === 'invalid_action' && e.message.includes('full HP')),
    'Heal at full HP: invalid');
  assert(g.models['A'].food === HEAL_COST, 'No food deducted');
}

// Heal without food
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.hp = 1;
  g.models['A'].food = 0;

  applyActions(g, 'A', [{ unitId: piece.id, action: 'heal' }]);
  assert(piece.hp === 1, 'No heal without food');
}

// ============================================================================
// 8. Scoring
// ============================================================================

section('Scoring');

{
  const g = createGame(['A', 'B']);
  // Clear all ownership
  for (let y = 0; y < GRID_SIZE; y++)
    for (let x = 0; x < GRID_SIZE; x++)
      g.grid[y][x].owner = null;

  // Give A some tiles
  g.grid[5][5].owner = 'A';
  g.grid[5][6].owner = 'A';
  g.grid[5][7].owner = 'A';

  const score = calculateScore(g, 'A');
  assert(score.tiles === 3, `A has 3 tiles, got ${score.tiles}`);
  assert(score.score === 3, `A score = 3 (no forts), got ${score.score}`);
}

// Fort-protected scoring
{
  const g = createGame(['A', 'B']);
  for (let y = 0; y < GRID_SIZE; y++)
    for (let x = 0; x < GRID_SIZE; x++)
      g.grid[y][x].owner = null;

  // Place a fort
  g.grid[10][10].tileType = 'fort';
  g.grid[10][10].fortHp = 5;
  g.grid[10][10].owner = 'A';

  // Claim neighbors
  g.grid[9][9].owner = 'A';
  g.grid[9][10].owner = 'A';
  g.grid[10][11].owner = 'A';

  const score = calculateScore(g, 'A');
  // Fort tile itself: owned by A, adjacent to itself? The fort IS at (10,10).
  // Neighbors at (9,9), (9,10), (10,11) are within 1 of the fort → 2 pts each.
  // Fort tile at (10,10) is also adjacent to itself? No — isFortProtected skips
  // dx=0,dy=0. But the fort IS the tile. Let me check: the fort tile is owned by A
  // and tileType=fort. isFortProtected checks 8 neighbors for forts owned by same model.
  // The tile at (10,10) is the fort itself — its neighbors are (9,9), (9,10), (9,11),
  // (10,9), (10,11), (11,9), (11,10), (11,11). None of THOSE are forts. So (10,10)
  // is NOT fort-protected by the definition. It counts as 1 pt.
  // But the neighbors ARE adjacent to the fort at (10,10), so they ARE fort-protected → 2 pts each.
  // Total: 1 (fort tile) + 3×2 (protected neighbors) = 7
  assert(score.tiles === 4, `A has 4 tiles, got ${score.tiles}`);
  assert(score.score === 7, `A score = 7 (1 fort tile + 3 protected × 2), got ${score.score}`);
}

// ============================================================================
// 9. Territory update
// ============================================================================

section('Territory update');

{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 15;
  piece.y = 15;
  g.grid[15][15].owner = null;

  updateTerritory(g);
  assert(g.grid[15][15].owner === 'A', 'Piece claims tile it stands on');
}

// Enemy fort protection blocks claiming
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 15;
  piece.y = 15;

  // Place enemy fort adjacent
  g.grid[15][16].tileType = 'fort';
  g.grid[15][16].fortHp = 5;
  g.grid[15][16].owner = 'B';
  g.grid[15][15].owner = null;

  updateTerritory(g);
  assert(g.grid[15][15].owner === null, 'Cannot claim tile near enemy fort');
}

// ============================================================================
// 10. Win conditions
// ============================================================================

section('Win conditions');

// Last survivor
{
  const g = createGame(['A', 'B']);
  g.models['B'].eliminated = true;
  // Remove B's pieces
  g.pieces = g.pieces.filter(p => p.modelName !== 'B');

  const result = checkWinCondition(g);
  assert(result.finished, 'Last survivor: finished');
  assert(result.winner === 'A', 'Last survivor: A wins');
  assert(result.reason === 'last_survivor', 'Last survivor: correct reason');
}

// Time up
{
  const g = createGame(['A', 'B']);
  g.tick = 100;
  // Give A more territory
  for (let x = 0; x < 20; x++) g.grid[0][x].owner = 'A';
  for (let x = 20; x < 30; x++) g.grid[0][x].owner = 'B';

  const result = checkWinCondition(g);
  assert(result.finished, 'Time up: finished');
  assert(result.winner === 'A', 'Time up: A wins (more territory)');
  assert(result.reason === 'time_up', 'Time up: correct reason');
}

// Game continues
{
  const g = createGame(['A', 'B']);
  g.tick = 5;
  const result = checkWinCondition(g);
  assert(!result.finished, 'Mid-game: not finished');
}

// ============================================================================
// 11. Multiple actions per turn
// ============================================================================

section('Multiple actions per turn');

{
  const g = createGame(['A', 'B']);
  const pieces = g.pieces.filter(p => p.modelName === 'A');
  pieces[0].x = 5; pieces[0].y = 5;
  pieces[1].x = 10; pieces[1].y = 10;
  pieces[2].x = 15; pieces[2].y = 15;

  const actions: PieceAction[] = [
    { unitId: pieces[0].id, action: 'move', direction: 'right' },
    { unitId: pieces[1].id, action: 'move', direction: 'down' },
    { unitId: pieces[2].id, action: 'move', direction: 'left' },
  ];

  applyActions(g, 'A', actions);
  assert(pieces[0].x === 6, 'Piece 0 moved right');
  assert(pieces[1].y === 11, 'Piece 1 moved down');
  assert(pieces[2].x === 14, 'Piece 2 moved left');
}

// More than 3 actions: only first 3 apply
{
  const g = createGame(['A', 'B']);
  const piece = g.pieces.find(p => p.modelName === 'A')!;
  piece.x = 10;
  piece.y = 10;

  const actions: PieceAction[] = [
    { unitId: piece.id, action: 'move', direction: 'right' },
    { unitId: piece.id, action: 'move', direction: 'right' },
    { unitId: piece.id, action: 'move', direction: 'right' },
    { unitId: piece.id, action: 'move', direction: 'right' }, // 4th — should be ignored
  ];

  applyActions(g, 'A', actions);
  assert(piece.x === 13, `3 moves applied (10→13), got ${piece.x}`);
}

// ============================================================================
// 12. advanceTick
// ============================================================================

section('advanceTick');

{
  const g = createGame(['A', 'B']);
  const tickBefore = g.tick;
  advanceTick(g);
  assert(g.tick === tickBefore + 1, `Tick advanced: ${tickBefore} → ${g.tick}`);
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('SOME TESTS FAILED — review output above');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
