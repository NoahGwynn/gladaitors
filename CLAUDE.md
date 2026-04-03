# gladAItors

## What this project is
A live entertainment platform where AI models (Claude, GPT-4o, Gemini) compete head-to-head
in graphical strategy game environments. The audience watches the game — not chat responses.
Each model controls an agent in a shared visual environment. Decisions are made via structured
API calls. The game never pauses.

## Planning docs (Notion)
Full detail on all decisions lives here — refer to these before making architectural changes:
- Overview: https://www.notion.so/337d4b78674381758ad3e7a1a3ff3107
- Challenge Ideas: https://www.notion.so/337d4b7867438116bc51fbbdb5dd9fbb
- Challenge Plans: https://www.notion.so/337d4b78674381749366c22cb68706ec
- Technical Architecture: https://www.notion.so/337d4b7867438125acd9d3ee5428dda0
- Build Plan: https://www.notion.so/337d4b78674381589d65ecea269acf87
- Business Model: https://www.notion.so/337d4b78674381d1be27d6dbf4819c0b

## Stack

### Frontend — `frontend/`
- Next.js (App Router) + TypeScript
- Phaser.js for all game rendering — each challenge is a Phaser Scene
- React handles the outer UI shell only (scoreboards, model panels, status badges)
- Phaser mounts inside a `'use client'` component via `useRef` div
- Communication between Next.js and Phaser via Phaser's EventEmitter
- WebSocket client receives game state from backend each tick, fires Phaser events
- Hosted on Vercel

### Backend — `backend/`
- Python + FastAPI
- asyncio.gather() for simultaneous AI model API calls
- WebSocket server pushes game state to all clients each tick
- Game engine is a state machine — backend owns all game logic
- AI adapter constructs prompts, calls models, validates structured JSON responses
- SQLite for episode/tick storage (every tick stored for replay)
- Hosted on Railway or Render

### AI Models
- Claude: `claude-sonnet-4-6` (Anthropic SDK)
- ChatGPT: `gpt-4o` (OpenAI SDK)
- Gemini: `gemini-flash` (Google Generative AI SDK)
- All calls use structured outputs / function calling — JSON schema enforced
- max_tokens: 150 per response. Temperature: 0.3. No extended thinking/reasoning modes.
- Hard timeout: 4 seconds per call. On failure: skip turn, show visual badge.

## Repo structure
gladaitors/

├── CLAUDE.md

├── README.md

├── frontend/

│   ├── app/

│   ├── components/

│   │   ├── GameContainer.tsx   ← 'use client', owns all Phaser logic

│   │   └── ui/                 ← scoreboard, panels, badges

│   ├── lib/

│   │   └── websocket.ts

│   └── phaser/

│       ├── scenes/

│       │   ├── TerritoryWarScene.ts

│       │   └── TradingPitScene.ts

│       └── game.ts             ← Phaser game instance config

└── backend/

├── main.py                 ← FastAPI app, WebSocket endpoint

├── game_engine/

│   ├── territory_war.py    ← state machine for Territory War

│   └── trading_pit.py      ← state machine for Trading Pit

├── ai_adapter/

│   ├── adapter.py          ← asyncio.gather, prompt builder, validator

│   └── schemas.py          ← Pydantic action schemas per challenge

└── storage/

└── db.py               ← SQLite episode/tick storage



## Current build step
**Step 1 — AI Adapter Proof of Concept**

A standalone Python script (no frontend, no WebSocket, no game) that:
- Calls all 3 models simultaneously with asyncio.gather()
- Sends a simple structured prompt with a JSON schema
- Logs response, latency, and token count per model
- Handles timeout and rate limit failure paths deliberately
- Uses cheapest models: claude-haiku, gpt-4o-mini, gemini-flash

Done when: all 3 models return valid JSON within 4 seconds, consistently, across 20 test runs.

See Build Plan in Notion for all 7 steps.

## Key rules
- Backend owns all game state. Frontend only renders.
- The game never pauses — failures skip the turn and show a visual badge.
- Never use random actions as a fallback — it misrepresents model decision-making.
- Expensive models (Opus, GPT-5, reasoning modes) are off-limits until post-pilot.
- Every tick is stored to SQLite — replays must use stored state, never re-run models.
- Lock model version strings in config per episode for attributability.
- Phaser `useEffect` must always clean up with `game.destroy(true)` to prevent duplicate instances on hot reload.

## Pilot budget
£60 total. API testing ~£8, pilot recording ~£20, domain ~£12, hosting free tier.
