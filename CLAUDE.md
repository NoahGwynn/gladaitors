# GladAItor

## What this project is

A live entertainment platform where AI models (Claude, GPT-4o, Gemini) compete head-to-head
in graphical strategy game environments. The audience watches the game — not chat responses.
Each model controls an agent in a shared visual environment. Decisions are made via structured
API calls. The game never pauses.

This repo contains two products:

- **Producer Tool** (`frontend/`) — localhost game renderer captured by OBS
- **Backend** (`backend/`) — game engine, AI adapter, and WebSocket server

The public viewer site (gladaitor.ai) is a separate repo — it embeds a stream, not the game.

---

## Planning docs (Notion)

Refer to these before making any architectural changes:

- Overview: https://www.notion.so/337d4b78674381758ad3e7a1a3ff3107
- Two Products Architecture: https://www.notion.so/337d4b78674381cd9c49cb952709c961
- Frontend Design Spec: https://www.notion.so/337d4b786743819d9d5fddff7f52874b
- Challenge Plans: https://www.notion.so/337d4b78674381749366c22cb68706ec
- Build Plan: https://www.notion.so/337d4b78674381589d65ecea269acf87
- Technical Architecture: https://www.notion.so/337d4b7867438125acd9d3ee5428dda0
- Broadcast Strategy: https://www.notion.so/337d4b78674381e3a900ea3f578cd1b3

---

## Producer Tool — `frontend/`

### What it is

The local game rendering tool for gladaitor. Runs at localhost:3000.
Never deployed. Never public. Captured by OBS via Browser Source.

### Stack

- Next.js (App Router) + TypeScript — NO SSR needed, this is localhost only
- Phaser.js for all game rendering — each challenge is a Phaser Scene
- React handles the outer UI shell only (model panels, scoreboard, status badges)
- Phaser mounts inside a `'use client'` component via `useRef` div
- CRITICAL: always clean up with `game.destroy(true)` in useEffect return
- Phaser EventEmitter handles communication between React and Phaser
- WebSocket client connects to gladaitor-backend on localhost:8000
- Designed for 1920x1080 — OBS Browser Source captures at this resolution

### Two routes

- `/` or `/game` — main game view, full screen, captured by OBS
- `/overlay` — transparent background, lower thirds only, second OBS Browser Source

### Repo structure

```
frontend/
├── app/
│   ├── page.tsx                ← redirects to /game
│   ├── game/
│   │   └── page.tsx            ← main game view (server shell)
│   └── overlay/
│       └── page.tsx            ← transparent lower thirds page
├── components/
│   ├── GameContainer.tsx       ← 'use client', owns ALL Phaser logic
│   ├── ModelPanel.tsx          ← single model status panel
│   ├── ModelPanelList.tsx      ← right column, 3 panels
│   ├── StatusBadge.tsx         ← reusable status badge component
│   ├── EventLog.tsx            ← bottom scrolling ticker
│   ├── GameHeader.tsx          ← top bar (turn, clock, episode)
│   ├── EventBanner.tsx         ← full-width scripted event notification
│   └── LowerThirds.tsx        ← overlay page components
├── phaser/
│   ├── game.ts                 ← Phaser game instance config
│   ├── events.ts               ← EventEmitter event name constants
│   └── scenes/
│       ├── TerritoryWarScene.ts
│       ├── TradingPitScene.ts
│       └── ResultsScene.ts     ← winner reveal, fires on game end
├── lib/
│   ├── websocket.ts            ← useGameSocket hook
│   └── types.ts                ← shared TypeScript types (GameState etc)
└── styles/
    └── globals.scss            ← SCSS variables, mixins, base styles
```

### Key types (from lib/types.ts)

```typescript
type GameState = {
  tick: number;
  max_ticks: number;
  elapsed_seconds: number;
  challenge: "territory_war" | "trading_pit";
  models: ModelState[];
  events: GameEvent[];
  canvas_data: object; // passed directly to active Phaser scene
};

type ModelState = {
  id: string; // 'claude' | 'gpt4o' | 'gemini'
  name: string;
  colour: string; // hex
  status: "active" | "thinking" | "timeout" | "rate_limited" | "invalid" | "winner" | "eliminated";
  primary_metric: number;
  primary_metric_label: string;
  stats: Record<string, string | number>;
  last_action: string;
};
```

### Model colours — never deviate from these

- Claude: `#7C3AED`
- GPT-4o: `#10B981`
- Gemini: `#3B82F6`

---

## Backend — `backend/`

### What it is

The game engine, AI adapter, and WebSocket server for gladaitor.
Runs locally during recording. Deployed to Railway for live broadcasts.

### Stack

- Python + FastAPI
- asyncio.gather() for simultaneous AI model API calls
- WebSocket server — pushes full game state to clients every tick
- SQLite — every tick stored for replay (never re-run models for replay)
- Pydantic for action schema validation

### Current status — LARGELY COMPLETE

- AI adapter: built and tested (15/15 Trading Pit, 3/3 Territory War)
- Game engines: Territory War and Trading Pit both complete
- Challenge runner: generic loop, WebSocket broadcast, SQLite storage
- REST endpoints: `POST /games/trading-pit` and `POST /games/territory-war`

### AI Models

- Claude: `claude-haiku` (testing) / `claude-sonnet-4-6` (recording)
- GPT: `gpt-4o-mini` (testing) / `gpt-4o` (recording)
- Gemini: `gemini-flash` (both)
- max_tokens: 150. Temperature: 0.3.
- Latency is not a constraint — all episodes pre-recorded. Tick rate can be 30–60s per turn.
- Extended thinking: ALWAYS disabled (verbose output, not latency).
- On failure: skip turn, emit badge, continue.

### Repo structure

```
backend/
├── main.py                     ← FastAPI app, WebSocket endpoint
├── game_engine/
│   ├── runner.py               ← generic challenge runner loop
│   ├── territory_war.py        ← state machine for Territory War
│   └── trading_pit.py          ← state machine for Trading Pit
├── ai_adapter/
│   ├── adapter.py              ← asyncio.gather, prompt builder, validator
│   └── schemas.py              ← Pydantic action schemas per challenge
└── storage/
    └── db.py                   ← SQLite episode/tick storage
```

---

## Key rules

- Backend owns ALL game state. The producer tool only renders.
- The game never pauses — failures skip the turn and show a visual badge.
- Never use random actions as a fallback — it misrepresents model decision-making.
- Expensive models (Opus, GPT-5, reasoning modes) are off-limits until post-pilot.
- Every tick is stored to SQLite — replays must use stored state, never re-run models.
- Lock model version strings in config per episode for attributability.
- Phaser `useEffect` must always clean up with `game.destroy(true)` to prevent duplicate instances on hot reload.
- The producer tool is NEVER deployed. Localhost only.
- Phaser on the public site (gladaitor-site) is forbidden — that site only embeds a stream.
- ResultsScene must be dramatic — it's the thumbnail moment for every episode.

---

## Pilot budget

£60 total. API testing ~£8, pilot recording ~£20, domain ~£12, hosting free tier.
