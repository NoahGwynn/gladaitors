# Territory War — Python to TypeScript Port Plan

**Status:** Starting. Foundation types and state machine first.

**Owner:** noah + Claude
**Last updated:** 2026-04-10

---

## What this is

Port the Territory War game engine from `backend/game_engine/territory_war.py`
into `site/lib/challenges/territory-war/` as TypeScript. The site becomes the
authoritative home for all game logic. This is item #0 from PRODUCT_ROADMAP.md.

---

## Source of truth: Python implementation

All game constants, rules, and behaviors come from the working Python code
in `backend/`. The TypeScript port must be behavior-identical. Key reference
files:

- `backend/game_engine/territory_war.py` — state machine, actions, scoring
- `backend/game_engine/runner.py` — turn loop, AI orchestration
- `backend/ai_adapter/adapter.py` — model calls, response parsing
- `backend/ai_adapter/schemas.py` — Pydantic action schemas
- `backend/ai_adapter/prompts/territory_war_system.txt` — system prompt
- `backend/ai_adapter/prompts/territory_war.txt` — per-turn user prompt
- `backend/test_territory_war.py` — test cases

---

## Game constants (from Python)

```
GRID_SIZE              = 30
PIECES_PER_MODEL       = 3
MAX_PIECES_PER_MODEL   = 10
PIECE_HP               = 3
PIECE_ATTACK           = 1
ORE_TILE_COUNT         = 30
FOOD_TILE_COUNT        = 15
ORE_PER_TILE           = random 5-15
FOOD_PER_TILE          = random 3-10
HARVEST_AMOUNT         = 3
FORT_COST              = 10 (ore)
FORT_HP                = 5
HEAL_COST              = 5 (food)
HEAL_AMOUNT            = 1
WIN_SCORE_THRESHOLD    = 0.6 (60% of total tiles = 540)
MAX_ACTIONS_PER_TURN   = 3 per piece
MAX_TICKS              = 100
```

Spawn corners (clockwise): TL(1,1), TR(28,1), BR(28,28), BL(1,28).
Each model gets a 3×3 claimed area around base + 3 pieces spawned toward center.

---

## Files to create

```
site/lib/challenges/territory-war/
├── constants.ts        — all game constants (GRID_SIZE, costs, etc.)
├── types.ts            — TileType, Tile, Piece, ModelState, ChallengeState,
│                         PieceAction, ChallengeEvent
├── state.ts            — createChallenge(), spawnModel(), initGrid()
├── actions.ts          — validateAction(), resolveAction(), applyActions()
├── scoring.ts          — calculateTerritory(), calculateScore(),
│                         checkWinCondition()
├── prompts.ts          — buildSystemPrompt(), buildTurnPrompt()
└── index.ts            — re-exports

site/app/api/challenges/territory-war/
└── route.ts            — POST handler (auth, tokens, SSE streaming,
                          AI calls, persistence)

site/supabase/
└── schema.sql          — games + challenge_turns tables (append to existing)
```

---

## Implementation order — 6 commits

### Commit 1: Types + Constants

Create the type definitions and game constants. No logic, just the data
shapes that everything else imports.

- `constants.ts` — all numeric constants, spawn positions
- `types.ts` — all interfaces (Tile, Piece, ModelState, ChallengeState,
  PieceAction, TerritoryWarResponse, ChallengeEvent)

Manual test: imports compile, types are correct.

### Commit 2: State initialization

Create a new game from scratch: grid generation, resource placement,
model spawning.

- `state.ts` — createChallenge(modelNames), initGrid(), placeResources(),
  spawnModel()
- Random resource placement (ore + food tiles with random amounts)
- Corner-based model spawning with 3×3 territory claim

Manual test: call createChallenge(['Claude', 'GPT', 'Gemini']), inspect the
resulting state — correct grid size, resources placed, pieces spawned
at correct corners, territory claimed.

### Commit 3: Actions — validation + resolution

The core game logic: validate each action against the rules, apply it
to the state, generate events.

- `actions.ts`:
  - validateAction(action, piece, state) → valid/invalid + reason
  - resolveMove(piece, direction, state) → updated state
  - resolveAttackPiece(piece, targetId, state) → damage, kill, eliminate
  - resolveAttackFort(piece, x, y, state) → damage, destroy
  - resolveHarvest(piece, state) → resource gain, tile depletion
  - resolveBuild(piece, state) → fort placed, territory claimed, ore deducted
  - resolveHeal(piece, state) → HP restored, food deducted
  - applyActions(state, modelName, actions) → updated state + events

Key validation rules to port exactly:
- Move: in-bounds check
- Attack piece: adjacency (including diagonals), enemy only
- Attack fort: adjacency, enemy-owned fort
- Harvest: must be on resource tile
- Build: empty tile only, ore >= FORT_COST
- Heal: hp < max, food >= HEAL_COST

Manual test: create a game, manually construct actions, apply them,
verify state changes match Python behavior.

### Commit 4: Scoring + win conditions

Territory calculation, score computation, and end-game detection.

- `scoring.ts`:
  - updateTerritory(state) — pieces claim tiles they stand on
    (skip tiles protected by enemy forts)
  - calculateScore(state, modelName) → number (1pt/tile, 2pt/fort-protected)
  - checkWinCondition(state) → { finished, winner, reason } | null
    - Score threshold (≥540)
    - Last survivor (all others eliminated)
    - Time up (tick ≥ max_ticks, highest score wins)

Fort protection: a tile is "fort-protected" if within 1 tile (8-neighbor
radius) of a fort owned by the same model with hp > 0. Protected tiles
score 2 instead of 1. Enemy pieces cannot claim fort-protected tiles.

Manual test: set up states with known territory, verify scores match
expected values. Test each win condition path.

### Commit 5: Prompts

Port the system prompt and per-turn user prompt from the Python
templates to TypeScript string builders.

- `prompts.ts`:
  - buildSystemPrompt(modelName, gameConfig) → string
    (port from territory_war_system.txt)
  - buildTurnPrompt(state, modelName) → string
    (port from territory_war.txt — includes territory scores,
    piece positions, resources, events, all as JSON)

The prompts must produce IDENTICAL output to the Python versions so
model behavior stays the same.

Manual test: generate prompts from a test game state, compare against
Python output for the same state.

### Commit 6: Schema + API route

Database tables + the API endpoint that drives the game.

- Schema additions to `site/supabase/schema.sql`:
  - `games` table (id, challenge, models, config, status, winner,
    challenge_state jsonb, created_at)
  - `challenge_turns` table (id, game_id, turn_number, challenge_state jsonb,
    model_responses jsonb, events jsonb)
  - RLS policies
  - Token-related RPCs (reuse existing deduct functions)

- `site/app/api/challenges/territory-war/route.ts`:
  - POST handler similar in shape to the debate route
  - Auth + session check
  - Token deduction per turn (or per game)
  - Create game → loop turns → call AI models sequentially →
    apply actions → check win → persist each turn
  - SSE streaming so the frontend can show live updates
  - Scripted events (tick 42: resource reveal)

This is the biggest commit. Reuses the existing AI adapter infrastructure
from the debate route (Anthropic/OpenAI/Google clients, streaming,
error handling, model config).

---

## Key design decisions

### Sequential turns (same as Python)

Territory War uses sequential turns: each model sees the actions of
models that already moved this tick. This is intentional — it creates
asymmetry and forces the AI to reason about incomplete information
(the models after you haven't moved yet).

The debate route's round-by-round model is different (one round = all
debaters). The game route needs a per-model-within-tick loop.

### Reuse the model registry

The existing `lib/models.ts` has all the provider configs. The game
route should use the same `getModel()` / `getStreamer()` / model
families. No duplicate model config.

### Reuse the AI adapter

The debate route's `streamClaude` / `streamGPT` / `streamGemini`
functions handle the provider-specific API calls. For games, we don't
need streaming (the response is a JSON action, not a prose argument).
But we can reuse the same client construction and error handling.

For games, use non-streaming calls: `client.messages.create()` instead
of `client.messages.stream()`. The response is small (3 actions in JSON)
and streaming it token-by-token adds no value for the game UI.

### Token cost model

Debate: 1 token per AI argument generated.
Game: TBD. Options:
- Per turn (e.g., 1 token per turn, ~100 turns = 100 tokens — too expensive)
- Per game (e.g., 10 tokens to start a game — simpler, more predictable)
- Free for the first N games, then per game

Decision deferred until the game is playable. Start with per-game for
simplicity.

### SSE events for the game

The debate route sends: thinking, token, argument, round_complete, etc.
The game route should send:
- `challenge_started` — initial state
- `turn_start` — which model is thinking
- `turn_actions` — the model's actions + resulting state
- `turn_complete` — all models have moved, tick advanced
- `challenge_complete` — winner, scores, reason
- `error` — model failure, etc.

### State persistence

Each turn's full state is stored in `challenge_turns` so replays can be
reconstructed from the database without re-running models (same
principle as debate arguments). The `games` table stores the latest
state for quick access.

---

## Recovery — if Claude crashes mid-port

1. Read this document.
2. Run `git log --oneline -10` to see how far we've gotten.
3. Check which files exist under `site/lib/challenges/territory-war/`.
4. Resume from the next uncompleted commit.

---

## What this does NOT include

- Frontend game renderer (Phaser scenes or canvas) — that's item #3
- Human player UI — that's item #1
- Trading Pit port — follows the same pattern once Territory War is proven
- Producer tool migration — that's item #0b
