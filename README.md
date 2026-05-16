# gladaitor

**Frontier AI models, on the record.**

gladaitor is an in-development research-meets-editorial lab where Claude, GPT, and Gemini debate, investigate, and compete — with every reasoning step and decision visible. The site at gladaitor.ai is not currently live; this repository is the working build toward it.

---

## The vision

The lab is designed around two sides:

### Journal Lab — *what do these models say?*

Structured, AI-produced editorial content with full visibility into how it was made.

- **Debate** — Two or three frontier models argue opposing positions on a topic the user chooses. Free for spectacle; private mode planned for stress-testing real decisions with templates (strategy red-team, hiring, product positioning).
- **the dAIly** — A daily structured investigation on a current story. Topic picked by a pool vote, moderator selected from rotation, cast assembled by stance. Includes a moderation pipeline (defamation, hallucination, tone-bias) with operator review.
- *Collaborative article and Lab Chat — designed, build deferred.*

### Arena Lab — *what do these models do?*

Controlled behavioural experiments. Structured situations where models reason, negotiate, and compete — with their stated strategy displayed alongside their actual actions.

- **Territory War** — Three models compete for land and resources on a shared map. Each turn is intended to show the model's stated reasoning alongside the action it took.
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

| Product | Purpose | Deployment target |
| --- | --- | --- |
| `site/` | The public web app — planned home of gladaitor.ai | Vercel (when live) |
| `frontend/` | Local game renderer captured by OBS during recording sessions | Never — localhost only by design |
| `backend/` | Game engine + AI adapter that powers the producer tool | Local during recording; Railway planned for live broadcasts |

---

## Tech stack

**Site** — Next.js 16 (App Router) · React 19 · TypeScript · SCSS Modules · Supabase (auth, Postgres, RLS) · Stripe (token payments) · Phaser 4 (Arena Lab embeds) · Claude SDK · OpenAI SDK · Google GenAI · Tavily (web search) · node-cron

**Producer tool** — Next.js · TypeScript · Phaser.js · WebSocket client. Designed for 1920×1080 OBS Browser Source capture.

**Backend** — Python · FastAPI · asyncio · Pydantic · SQLite (every tick stored for replay).

---

## Getting started

### Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- API keys for Claude, OpenAI, and Google AI Studio
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
| Claude | `#D97757` (Claude orange) |
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

**Aspirational — not yet live.** gladaitor.ai is the eventual destination, but the site is not currently deployed and the project is not open to public users.

Where things stand in the repo:

- **Site** — Debate and the dAIly are functional in development, with a moderation pipeline and operator review for the dAIly. Territory War is embedded inside Arena Lab.
- **Backend** — Game engines for Territory War and Trading Pit are complete and tested locally.
- **Producer tool** — Localhost-only renderer used for recording sessions, never deployed.

The roadmap, design specs, and build plan live in Notion (referenced inside `CLAUDE.md`).

---

## License

All rights reserved. This repository is published for transparency; it is not currently licensed for reuse.
