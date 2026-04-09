# GladAItors — Product Roadmap

Ordered by impact-to-effort. Build top-down.

The core strategic shift: stop treating the documentary as the primary product.
The interactive platform IS the product. The documentary becomes a highlight reel
of the best moments the platform produces. Your time goes to the platform, which
generates content without you.

---

# PHASE 1 — Ship the core loop

These items transform the site from a one-shot tool into a platform people return to.

---

## 0. Port the game engine to TypeScript inside `site/`

**Priority: Foundation — must happen before any game-related feature**

Move the game engine out of the standalone Python `backend/` and into the public site
as TypeScript. The site becomes the authoritative home for all game logic. This is the
start of fully retiring the Python backend — long-term there is one game engine, in one
language, used by both the public site and the producer tool.

**What this involves:**

- Create `site/lib/games/territory-war/` containing:
  - `state.ts` — `TerritoryWarState`, `Piece`, `Tile` types and the state machine
  - `actions.ts` — action validation and resolution (move, attack, harvest, build, heal)
  - `scoring.ts` — territory scoring with fort multipliers and win conditions
  - `prompts.ts` — system + turn prompt builders (port from `prompts/territory_war*.txt`)
- A `runChallengeTurn()` function that:
  - Loads game state from Supabase
  - Calls the AI adapters (already TypeScript in the site for debate)
  - Applies actions to the state
  - Saves the new state back to Supabase
- New API route `POST /api/games/[challenge]` that drives the loop, similar in shape to
  `POST /api/debate` (auth + token deduction + SSE streaming + safety checks)
- Database tables for game persistence: `games`, `game_turns` (so replays are stored
  the same way debates are — never re-run models for replay)
- Port the existing test cases so behaviour parity is verifiable before shipping

**What this does NOT involve (yet):**

- Touching the producer tool (`frontend/`) or its Python backend (`backend/`).
  Documentary recording continues unchanged on Python while the TypeScript engine
  matures on the site. Migration of the producer tool happens in step 0b below, not now.
- Building the human-player UI — that's item #1, this just lays the foundation.
- Building the spectator renderer — that's item #3, but it can start as soon as this
  is done.

**Why this comes first:**

Every other game-related item in this roadmap (#1, #3, #6, #8, #10) depends on the site
being able to run a game. Doing this once, properly, in TypeScript means:

- One language across the public-facing product (no Python service to deploy or pay for)
- One deploy on Vercel, one Supabase project, one billing relationship
- The same auth, token, payment, and safety-check infrastructure the debate route already
  uses works for games immediately
- Future challenges (Trading Pit, Prisoner's Dilemma, etc.) follow the same pattern —
  drop a new folder under `site/lib/games/`, add an API route, ship

The producer tool keeps running on Python until there's a reason to migrate it. When
the site's TypeScript engine has matured, the game logic can be extracted into a shared
workspace package (`packages/game-engine`) that both the site and the producer tool
import — one implementation, used everywhere. That's a refactor, not a rewrite, and it
happens later when the constraints justify it.

**Effort:** ~1-2 weeks of focused work for Territory War. Subsequent challenges are
faster because the patterns are established.

**No user-visible change** — this ships nothing on its own. It's the foundation that
makes everything else possible.

---

## 0b. Migrate the producer tool to the TypeScript engine, retire Python backend

**Priority: Foundation — happens after step 0 has matured on the live site**

Once the TypeScript game engine has been running on the public site for long enough to
prove parity with the Python implementation, migrate the producer tool to use it too.
This is the step that fully retires the `backend/` Python service.

**What this involves:**

- Extract `site/lib/games/` into a TypeScript workspace package: `packages/game-engine`
- Both `site/` and `frontend/` (producer tool) import the package as a dependency
- The producer tool's Phaser scenes keep their existing rendering — only the game logic
  source changes from "Python over WebSocket" to "TypeScript via direct function calls"
- The producer tool's `useGameSocket` hook is replaced with a local game runner that
  uses the same TypeScript engine the site uses
- Delete `backend/` once the producer tool is fully migrated and a recording session has
  proven the new path works end-to-end
- Delete the Python AI adapter — the site already has TypeScript adapters for all three
  providers and they're battle-tested

**What this gives us:**

- One game engine, one language, used by both products
- Bug fixes apply everywhere by default — no risk of drift between site and producer
- New challenges are added in one place and immediately work for both products
- Zero second-service hosting (no Railway, no Fly, no Python deploy)
- Zero second-language maintenance burden

**Why not do this at the same time as step 0:**

The Python backend works today and the producer tool depends on it for documentary
recording. Migrating both at once means *all* game-related functionality is broken until
both halves are done. Doing the site first means the new engine can be validated by real
users before the producer tool is touched, which is much safer than trusting an
unvalidated rewrite.

**Effort:** ~3-5 days once the TypeScript engine is mature and proven on the site.

---

## 1. Human vs AI — Territory War

**Priority: Critical — the single most important feature**

Let users play Territory War against AI models. "Can you beat Claude?" is the hook.

- User takes one player slot, AIs fill the others (1v1, 1v2, or 1v3)
- Same game state, same action set (move, attack, harvest, build, heal)
- Human submits actions via a UI form instead of an API call
- Simultaneous turns (all players submit at once, then resolve) for pacing
- 60-second turn timer to prevent stalling
- Backend change is minimal: replace one AI adapter call with a WebSocket input wait
- Game engine doesn't care whether actions come from an API or a browser

**Why:** This transforms the site from a content platform into a competitive game platform.
"I beat Claude at strategy" is identity-level engagement — it gets screenshotted, shared,
and retried. Natural session length: 15-30 minutes. Natural return rate: days, not weeks.

**Monetisation:** ~15 tokens per human-vs-AI game. Lower API cost (fewer AI calls) but
higher perceived value to the user.

**The leaderboard unlock:** A human leaderboard ("Top humans vs Claude this week") creates
status competition among users. Where there's a leaderboard, there's retention.

---

## 2. Audience Voting — "Who Won?"

**Priority: Critical — build alongside or immediately after #1**

Add a vote prompt at the bottom of every debate and every AI-vs-AI game replay.
Users pick which model (or human) they think played best. Show aggregate results after voting.

- Single `votes` table (content_id, content_type, voter_id/session_id, model_id)
- One vote per viewer per piece of content
- Display as horizontal bar chart after voting
- Unlocks leaderboard data: "Claude wins 62% of Territory War games"
- Works across debates AND game replays — shared infrastructure

**Why:** Without this, every piece of content has no resolution. Voting turns passive
readers into participants and gives creators/players a reason to share.

---

## 3. Standalone AI-vs-AI Games on the Site

**Priority: Critical — runs parallel to #1**

Make Territory War (and later Trading Pit) playable as token-gated spectator
experiences on gladaitors.com. User hits "Run Game", watches it play out live.

- Adapt the existing Phaser scenes for the public site (the rendering is built)
- Expand the strategy/reasoning display: add a round-level `strategy` field to
  the response schema so models output high-level plans, not just per-action reasoning
- Side panel shows each model's thinking as the game plays — this is the differentiator
- Shareable replay links (same pattern as debates)
- User picks which models compete (or randomise)

**Why:** The game results already produce fascinating content (GPT planning forts for
two games without building one, Claude's methodical resource targeting). Let users
discover these findings themselves.

**The strategy display is the product.** "Move toward food resource at (5,0) to start
harvesting" vs "Moving to claim more territory" — that contrast between Claude and GPT
tells the whole story. Making model reasoning visible turns a board game into a window
into how AI thinks.

---

# PHASE 2 — Build the social layer

These items turn individual sessions into a community.

---

## 4. Public Results Feed + Leaderboards

**Priority: High — the social glue**

- Feed of recent/popular games and debates on the homepage
- Model leaderboard: win rates across all user-run games and debates
- Human leaderboard: top human players vs AI
- Filter by challenge type, model, time period

**Why:** This turns GladAItors from "a tool I used once" into "a place I check."
The difference between £200/month and £2k/month is almost always community, not features.

---

## 5. Notifications on Shared Content

**Priority: High — closes the re-engagement loop**

When a shared debate or game replay gets views or votes, notify the creator:

- "Your Territory War game has been viewed 47 times"
- "63% think Claude played best in your debate"
- Email digest (daily or weekly, not per-event)
- Optional in-app notification badge

**Why:** Every view and vote is a missed pull-back opportunity without this.

---

## 6. New Model Releases = Free Marketing Events

**Priority: High — zero-effort recurring content**

Every time a new model ships (GPT-5, Claude 4.5, Gemini Ultra, etc.), be the site
that answers "is it better?" through gameplay.

- Lightweight model config swap (AI adapter already supports this)
- Run comparison games immediately on release day
- Post results to Twitter/Reddit: "GPT-5 vs Claude — first Territory War results"
- Let users run their own comparisons

**Why:** This is free, recurring content marketing tied to moments when AI interest
peaks. You don't produce it as a documentary — just run the game, post the results.

---

## 7. Templates + Trending + Remix

**Priority: Medium — reduces friction on repeat usage**

For debates:
- **Templates:** Pre-built topic + position combos ("Is AI art real art?", "Tabs vs spaces")
- **Trending:** What others are debating/playing this week
- **Remix:** Button on any shared content to re-run with different models or settings

For games:
- **Scenario presets:** "Aggressive start", "Resource race", "3-way war"
- **Rematch:** Re-run the same matchup to see if results differ

**Why:** Most users have one idea in them. Templates provide the spark for the second
and third session. That's where retention lives.

---

# PHASE 3 — Expand and deepen

These items add depth for engaged users and unlock new audiences.

---

## 8. East vs West — DeepSeek, Qwen, Kimi

**Priority: High for marketing, medium for engineering**

Add Chinese AI models as opponents. DeepSeek vs Claude in Territory War is exactly
the kind of content that goes viral on AI Twitter.

- DeepSeek V3/R1, Qwen 3, Kimi K2 all have international API access
- Frame as curiosity, not nationalism: "Different training, different strategies"
- Don't wait for Season 2 — this should be one of the first standalone game options

**Why:** The cultural tension is real, the curiosity is genuine, and nobody else is
doing it as interactive entertainment.

---

## 9. Follow-Up Rounds / Extend Games

**Priority: Medium — low-friction monetisation**

After a debate ends: "Add 2 more rounds for X tokens?"
After a game ends: "Run 20 more turns for X tokens?"

- Resume functionality already exists in debate codebase
- User is already invested — conversion is natural
- Free 3-round debates convert into paid extensions without a hard paywall

**Why:** The moment someone thinks "I wish they'd gone deeper" is the highest-intent
moment to convert. Meet them there.

---

## 10. More Challenges — Prisoner's Dilemma, Trading Pit, Newcomb's Box

**Priority: Medium — expand once Territory War is proven**

Roll out additional challenges from the library:

- **Trading Pit** (already built in backend) — spectator + human player modes
- **Prisoner's Dilemma** — mechanically simple, philosophically deep, fast to play
- **Newcomb's Box** — minimal input, maximum engagement, theory-of-mind showcase
- **Hidden Hand Card Battle** — card games are proven UX, high replayability

Each new challenge is a new reason to return and a new piece of shareable content.

**Why:** Don't ship these all at once. Each new challenge is a marketing event —
"New on GladAItors: Prisoner's Dilemma." Space them out for sustained attention.

---

## 11. Public User Profiles

**Priority: Medium — adds identity and status**

- Display name, games played, win rate vs AI, debates run, votes received
- Gallery of public games and debates
- "Beat Claude 12 times" as a visible achievement
- Optional — users can keep content private by default

**Why:** Status drives retention. A profile turns casual users into invested ones.

---

## 12. Weekly Digest — "This Week on GladAItors"

**Priority: Medium — content marketing + re-engagement**

Auto-rank content by votes and views. Curate a weekly top 10.

- Best debates, most interesting game results, top human players
- Email to opted-in users + post on social channels
- Feature on site homepage

**Why:** Pulls existing users back and acts as organic marketing for new ones.

---

# PHASE 4 — Premium and long-tail

Build these once the platform has traction and repeat users.

---

## 13. Subscription Tier

**Priority: Low until proven demand**

- £9.99/month = 30 games/debates per month + leaderboard badge + early access to new challenges
- Add once token purchase data shows repeat buyers

---

## 14. The Documentary Series

**Priority: Low — let the platform generate the content first**

When the platform has enough interesting moments, the documentary becomes a
highlight reel. Curate the best findings:

- "GPT planned forts for two games without building one"
- "A human beat all three AIs using a strategy none of them considered"
- "DeepSeek and Claude collaborated better than any same-company pair"

The platform produces the raw material. The documentary packages it.

---

## 15. Advanced Challenges

**Priority: Low — Season 2 material**

- **Collaboration Triangle** — cross-company AI pairs, hidden collaboration scoring
- **The Investigation** — deduction and deception under cross-examination
- **The Labyrinth** — spatial exploration with public goods economics
- **The Crisis** — ethical decision-making under pressure
- **Do They Have Free Will?** — the philosophical capstone

These require established model personalities and an engaged audience to land.

---

# Summary

| # | Feature | Effort | Impact | Phase |
|---|---------|--------|--------|-------|
| 0 | Port game engine to TS in `site/` | Medium | Foundation | 1 |
| 0b | Migrate producer tool, retire Python backend | Low-Med | Foundation | 1 |
| 1 | Human vs AI games | Medium | Critical | 1 |
| 2 | Audience voting | Low | Critical | 1 |
| 3 | Standalone AI-vs-AI games | Medium | Critical | 1 |
| 4 | Public feed + leaderboards | Medium | High | 2 |
| 5 | Notifications | Low-Med | High | 2 |
| 6 | New model release events | Low | High | 2 |
| 7 | Templates + trending + remix | Medium | Medium | 2 |
| 8 | East vs West models | Medium | High | 3 |
| 9 | Follow-up rounds / extend | Low | Medium | 3 |
| 10 | More challenges | Med-High | Medium | 3 |
| 11 | Public profiles | Medium | Medium | 3 |
| 12 | Weekly digest | Low | Medium | 3 |
| 13 | Subscription tier | Low | Medium | 4 |
| 14 | Documentary series | High | Medium | 4 |
| 15 | Advanced challenges | High | Low | 4 |

---

# The path to £2k/month

| Source | Users | Activity | Net revenue |
|---|---|---|---|
| Human vs AI games | 100 | 3 games/month | ~£360 |
| AI-vs-AI spectator games | 80 | 2 games/month | ~£240 |
| Debates | 150 | 4 debates/month | ~£720 |
| Subscriptions (Phase 4) | 80 | £9.99/month | ~£800 |
| **Total** | | | **~£2,120** |

API costs at this scale: ~£400-500/month. Gross revenue needed: ~£2,500.

The key insight: human-vs-AI games are higher value, higher retention, and lower
API cost per session. They're the engine that makes everything else work.
