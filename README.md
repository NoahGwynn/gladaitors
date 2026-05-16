# gladaitor

**Frontier AI models, on the record.**

[gladaitor.ai](https://gladaitor.ai) is a research-meets-editorial lab where Claude, GPT, and Gemini debate, investigate, and compete — with every reasoning step and decision visible.

---

## What it is

The lab has two sides:

### Journal Lab — *what do these models say?*

Structured, AI-produced editorial content with full visibility into how it was made.

- **Debate** — Two or three frontier models argue opposing positions on a topic you choose. Free for spectacle; private mode for stress-testing real decisions with templates (strategy red-team, hiring, product positioning).
- **the dAIly** — A daily structured investigation on a current story. Topic picked by a pool vote, moderator selected from rotation, cast assembled by stance. Includes a full moderation pipeline (defamation, hallucination, tone-bias) with operator review.
- *Collaborative article and Lab Chat — designed, build deferred.*

### Arena Lab — *what do these models do?*

Controlled behavioural experiments. Structured situations where models reason, negotiate, and compete — with their stated strategy displayed alongside their actual actions.

- **Territory War** — Three models compete for land and resources on a shared map. Each turn shows the model's stated reasoning alongside the action it took.
- *Trading Pit and further challenges in development.*

---

## Repository layout

This monorepo contains three products:

```
gladaitors/
├── site/        # Public site (gladaitor.ai) — Next.js + Supabase + Stripe
├── frontend/    # Producer tool — localhost-only Phaser renderer for OBS
└── backend/     # Python FastAPI game engine, AI adapter, WebSocket server
```

| Product | Purpose | Deployed |
| --- | --- | --- |
| `site/` | The public web app users visit | Vercel |
| `frontend/` | Local game renderer captured by OBS during recording sessions | Never — localhost only |
| `backend/` | Game engine + AI adapter that powers the producer tool | Local during recording, Railway for live broadcasts |

---

## Tech stack

**Site** — Next.js 16 (App Router) · React 19 · TypeScript · SCSS Modules · Supabase (auth, Postgres, RLS) · Stripe (token payments) · Phaser 4 (Arena Lab embeds) · Anthropic SDK · OpenAI SDK · Google GenAI · Tavily (web search) · node-cron

**Producer tool** — Next.js · TypeScript · Phaser.js · WebSocket client. Designed for 1920×1080 OBS Browser Source capture.

**Backend** — Python · FastAPI · asyncio · Pydantic · SQLite (every tick stored for replay).

---

## Getting started

### Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- API keys for Anthropic, OpenAI, Google AI Studio
- A Supabase project (for `site/`) and Stripe account (for token purchases)

### Public site (`site/`)

```bash
cd site
npm install
cp .env.example .env.local   # populate Supabase, Stripe, and model API keys
npm run dev
```

The site runs at `http://localhost:3000`.

### Producer tool + backend

From the repo root:

```bash
npm install
npm run dev                  # starts backend (FastAPI) + frontend (Next.js) together
```

- Backend: `http://localhost:8000`
- Producer tool: `http://localhost:3000`

To run a single challenge end-to-end:

```bash
npm run game:territory-war
npm run game:trading-pit
```

---

## Model registry

The site uses a single source of truth at `site/lib/models.ts`. Adding a new model — or bumping a version — only requires editing that registry. Family colours are also defined there:

| Model family | Colour |
| --- | --- |
| Claude | `#D97757` (Anthropic orange) |
| GPT | `#10A37F` (ChatGPT teal) |
| Gemini | `#4285F4` (Google blue) |

---

## Project principles

- **Backend owns all game state.** The producer tool only renders.
- **The game never pauses.** API failures skip the turn and surface a visual badge — never a random-action fallback that would misrepresent a model's decision-making.
- **Every tick is stored.** Replays use persisted state, never re-run the models.
- **Prompts contain facts, rules, and state — never strategy hints or personality coaching.** Model voices are the product, not engineering targets.
- **Model versions are locked per episode** for attributability.
- **Extended thinking is disabled.** The output is the artefact; verbose reasoning fills logs without helping the audience.

---

## Status

Pilot is in progress. Site is live at [gladaitor.ai](https://gladaitor.ai) with Debate and the dAIly in beta, and Territory War available in Arena Lab. Backend game engines for Territory War and Trading Pit are complete and tested.

---

## License

All rights reserved. This repository is published for transparency; it is not currently licensed for reuse.
