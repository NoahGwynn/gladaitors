The strategic direction for [**gladaitor.ai**](http://gladaitor.ai) — what the site is, what it's becoming, and what gets built in what order. This is a living document. It should be revisited after every significant ship and updated when reality diverges from the plan.

---

## What [gladaitor.ai](http://gladaitor.ai) is

> _"See what frontier AI models actually do when you put them in structured situations — and why they say they did it."_

[gladaitor.ai](http://gladaitor.ai) is an **experimentation lab** for frontier AI behaviour. Every challenge on the site is a structured situation where users can observe what Claude, GPT-4o, and Gemini actually do alongside what they say they're doing. The interesting content always lives in the gap between the two — between stated reasoning and actual output.

The debate arena is the first expression of this. Models argue positions and the audience watches the reasoning in real time. Territory War is the second — three models competing for land and resources, with per-turn stated reasoning displayed alongside their actual moves. Future challenges will extend the same idea into different mechanics: negotiation, prediction, cooperation, nerve, pattern-matching. The through-line is observation of behaviour, reasoning, and outcome — not gamification.

**This positioning has three advantages over the alternatives we considered:**

- It's closest to what the project actually is — the Notion workspace has been building structured experiments the whole time, just under the documentary framing. The lab framing names what was always there.
- It has almost no direct competitors. AI entertainment content sits on one end (viral clips, no depth); academic AI research sits on the other (inaccessible, slow). The thoughtful middle — _"what do these models actually do when you put them in structured situations, explained for curious people"_ — has a clear lane.
- It monetises on a small, engaged audience rather than requiring viral scale. Hundreds of paying users at £5/month is enough. Millions are not required.

The debate arena and Territory War together act as the **entertainment wedge** — low friction, immediately understandable, shareable, broad appeal. They pull people into the site. The deeper challenges and observational content is what makes them stay.

---

## Current state (as of 9 April 2026)

**Live on [gladaitor.ai](http://gladaitor.ai):**

- The Arena (top-level container)
- Debate (first Arena sub-page) — pick a topic, assign positions, watch Claude/GPT/Gemini argue, vote
- Explore page for browsing public debates
- Sign In
- Hero showcase debate: _"Which AI model is the best?"_

**Built but not yet deployed:**

- Territory War — TypeScript game engine, full UI. Remaining work: graphics refinement and the strategy feedback UI (the per-turn thought-process log). Ships as the second Arena sub-page.

**In progress:**

- Debate v2 for new users (nearly ready)
- TypeScript backend stabilisation

**Not live, in Notion only:**

- Every other challenge in the library

---

## The Arena architecture

The Arena is a hub. Each challenge is a sub-page within it, following the pattern established by Debate. This is the right structure for the experimentation lab model because:

- Every new challenge adds to a coherent whole rather than fragmenting the product
- Users build a mental model of _"the Arena has different kinds of experiments"_ rather than _"the site has unrelated games"_
- Site-level features (history, leaderboards, sharing, accounts) work across all challenges automatically
- New challenges inherit the visual identity and navigation of the Arena without bespoke design work

**Implication for every new challenge from now on:** it needs to answer three questions during design, not one.

1. **How does a user play it themselves?** (human-vs-AI mode, where applicable)
2. **How does a user watch it?** (AI-vs-AI spectator mode)
3. **How does a user configure their own run?** (matchup, parameters, personas)

Not every challenge will support all three modes. But every challenge design should explicitly state which modes it supports and why.

---

## Build order

### Phase 1 — Ship the Arena (now → ~6 weeks)

The goal of Phase 1 is to go from "debate site" to "multi-format lab" in the shortest possible time. The single strategic insight here is that **shipping Territory War alongside Debate v2 fundamentally changes what the Arena is**. One format is a product. Two formats is a category. Users encountering the site for the first time need to see at least two different kinds of experiment in the Arena for the lab framing to land.

- **Debate v2 for new users** — already in progress. Ship first.
- **TypeScript backend stabilisation** — in progress. Everything depends on this being solid.
- **Territory War graphics refinement** — in progress.
- **Territory War strategy feedback UI** — the per-turn thought-process log showing each model's stated reasoning alongside their actual actions. This is the single most important piece of lab-identity work in the entire roadmap. It turns Territory War from "a game you watch" into "an observation of how three models reason and act." Every promise the lab makes is expressed here. Worth investing real time to get right.
- **Territory War deployment** as the second Arena sub-page.
- **Site shell**: a homepage showing recent activity across the Arena, basic user history (your runs, your votes), share cards for every run with a good social preview, and a "What is the Arena?" explainer page that lands the lab framing in 30 seconds.
- **Per-challenge leaderboards** for Debate (which model wins debates most often) and Territory War (which model wins games, plus secondary stats like fort-build rate, spatial reasoning patterns). These are the lab's first visible data artefacts.
- **Fix the GAME OVER score display bug** — currently shows tile counts rather than territory scores, making the winner look wrong. Small fix, big impact on legibility.

### Phase 2 — Squeeze what's live (~6–14 weeks)

Extend the two live formats before building new ones. Also the first real monetisation. The principle: the cheapest next features are variants of things you've already built.

**Debate extensions:**

- Tournaments / brackets — round-robin or single-elimination across multiple topics
- Judge modes — AI judges, audience judges, blind judges
- User-submitted topic queue with community voting (extends Explore page)
- Debate personas — user assigns not just position but character. First natural gated feature.

**Territory War extensions:**

- User-configurable matchups — pick the models, starting positions, map size
- Replay browser for archived runs, searchable by model and outcome
- Behaviour dashboard aggregating across all public runs — Claude's average fort-build turn, GPT's path-planning failure rate, Gemini's schema validation error rate, combat emergence patterns. **This is the lab's data made public and is the clearest possible demonstration of what the site is for.**

**Monetisation foundation:**

- Welcome token grant for new signups
- Weekly top-up for signed-in users
- Token packs (£3 / £10 / £25) live in Stripe
- Tip jar / "Support the Lab"
- Hard monthly API budget ceiling enforced in code (ships in Phase 1 but monitored through Phase 2)
- Model-tiered token costs (cheap models cost fewer tokens than flagship)

**Phase boundary review:** Is Arena engagement growing? Are users converting from welcome grant to first token purchase? Is Territory War actually pulling the kind of audience that justifies graphical investment, or is the text-based debate doing the heavy lifting? The answer shapes Phase 3 scope.

### Phase 3 — Extend the library (~14–24 weeks)

First new challenges beyond the two already live. All text-based, all reusing existing infrastructure, all relatively fast to build.

- **The Pot** — simplest build in the library. Human-vs-AI nerve and pattern-reading. Highly shareable. First test of whether the Arena model works for human-play formats.
- **The Mirror** — human-vs-AI alignment quiz. Strongest monetisation fit in the library. Works as a reusable lens that can layer on top of other challenges.
- **Prisoner's Dilemma** — classic head-to-head cooperation/defection with simultaneous reveals. Iconic format, immediately legible, reuses text infrastructure.
- **Newcomb's Box** — theory of mind prediction game. Pairs with Prisoner's Dilemma as a two-challenge thematic block.

### Phase 4 — Depth (24+ weeks, conditional on traction)

Only if Phases 1–3 have proven engagement and the lab is producing some revenue. The most complex and most content-rich challenges.

- **The Investigation** — sustained false-narrative deduction. Richest content of the text-based experiments.
- **The Crisis** — emergency command decision-making under pressure. Excellent lab content, real-world relevance.
- **Additional models** — DeepSeek, Kimi, Qwen. The East vs West framing becomes a concrete feature rather than an abstract variant, applied to Debate and Territory War first.
- **Collaboration Triangle** — cross-competitor deference in Territory War. Complex orchestration, significant build.
- **Identity Experiment** — applied as a variant layer across Debate, Prisoner's Dilemma, and Collaboration Triangle.
- **Public API / researcher data access** — aggregate behavioural data queryable by third parties. The lab identity earns this feature.

---

## Challenges Library triage

The existing Challenges Library was designed for a documentary series that is now shelved. Most of it translates to the Arena model, but not all of it. Honest triage:

### Ship path (in the roadmap above)

| Challenge                  | Phase                     | Notes                                                                                                                                        |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Debate**                 | Live (extensions Phase 2) | Already shipped.                                                                                                                             |
| **Territory War**          | Phase 1                   | Game engine built in TS. Full UI built. Graphics refinement and strategy feedback UI are the remaining work. Ships as second Arena sub-page. |
| **The Pot**                | Phase 3                   | Simplest build. First human-vs-AI format.                                                                                                    |
| **The Mirror**             | Phase 3                   | Best monetisation fit. Reusable lens layer.                                                                                                  |
| **Prisoner's Dilemma**     | Phase 3                   | Classic, legible, reuses text infrastructure.                                                                                                |
| **Newcomb's Box**          | Phase 3                   | Pairs with Prisoner's Dilemma.                                                                                                               |
| **The Investigation**      | Phase 4                   | Richest content, most complex of the text-based.                                                                                             |
| **The Crisis**             | Phase 4                   | Excellent lab content, needs significant UI work.                                                                                            |
| **Collaboration Triangle** | Phase 4                   | Extends Territory War with cross-competitor orchestration.                                                                                   |
| **Identity Experiment**    | Phase 4                   | Variant layer applied to multiple challenges, not standalone.                                                                                |
| **East vs West**           | Phase 4                   | Applied as added models to Debate and Territory War.                                                                                         |

### Parked for now

These exist in the library but don't fit the near-term Arena model. They're not deleted — they're set aside for a later decision.

- **Trading Pit** — parallel play rather than true head-to-head. Interesting as a market-reaction experiment but weaker as an Arena format. Revisit if Phase 4 has capacity.
- **Survival Colony** — complex balance work. Revisit once several Arena challenges are live.
- **Hidden Hand** — bespoke card game with significant custom design effort.
- **The Labyrinth** — most complex build in the library. Originally designed as a season finale. Revisit only if the Arena proves it can sustain deep, long-form observational content.
- **Secret Villain** — variant of Prisoner's Dilemma. Revisit after the base format is live.
- **Free Will / Determinism** — this is an experiment set, not a challenge. Probably belongs in the separate Experiments section of the workspace, or as a structured research artefact rather than an Arena sub-page. Decision deferred.

### Removed from scope

Nothing is being deleted, but the following should be understood as **not part of the product direction**:

- All documentary series planning (episode structure, script notes, broadcast format, callbacks)
- The Two Products architecture (this is now one product, not two)
- Commentary workflows, OBS production chains, ElevenLabs narration planning

These may become relevant again if the series ever restarts as a secondary content layer, but they should not drive any near-term build decisions.

---

## Site-level features

The Arena is only as good as the meta-layer that holds it together. These features are cross-cutting — they aren't specific to any one challenge and they multiply the value of every challenge that ships.

**Must-haves for Phase 1:**

- Homepage showing recent activity across all Arena challenges
- User account with basic history (your runs, your votes, your saved results)
- Share cards for every run with a genuinely good social preview — this is how the site grows organically
- A "What is the Arena?" explainer page that lands the lab framing in 30 seconds
- Per-challenge leaderboards tracking model performance over time

**Desirable for Phase 2:**

- Weekly curated finding — one behavioural observation each week, pulled from recent runs across the Arena. Editorial content that reinforces the lab identity without requiring new infrastructure.
- Run archive browsable by model, by challenge, by date
- Model profile pages — Claude's profile showing how it has performed across all Arena challenges, what patterns it exhibits

**Desirable for Phase 3+:**

- Public API for researchers to query aggregate data
- Downloadable datasets of runs for external analysis
- Embeddable debates and challenges for other sites

---

## Monetisation

The goal is **small, steady revenue that rewards the work** — not viral scale, not investor pitches, not ad-supported attention mining. A realistic target is enough monthly income to cover API costs comfortably and pay something back for the time invested.

**Tokens are the model.** Already built. They match the lab identity: every action on the site is a discrete experiment with a discrete cost, and tokens make that relationship honest and visible. This aligns user spending with actual API cost, unlocks whale behaviour from heavily engaged users, and avoids the subscription fatigue that kills conversion for small sites.

**The structure:**

- **Free signup welcome grant.** Generous enough to meaningfully try things across multiple challenges. The first-experience moment that decides whether someone stays.
- **Weekly top-up for signed-in users.** A small automatic grant each week just for being active. The retention hook. Costs almost nothing on cheap models and gives users a reason to come back.
- **Token packs at classic price points.** £3, £10, £25, with bonus tokens on the larger packs so the average purchase pushes upward without feeling exploitative.
- **Tokens never expire.** This is critical. Expiring tokens destroy trust and turn casual users into churned users. Non-expiring balances keep users coming back even after months away because they remember they have something waiting.
- **Model tiering on token cost.** Cheap-model debates cost fewer tokens than flagship-model debates. Territory War matches cost more than debates because they're longer and more expensive to run. Users see the cost before committing, which makes the economy feel fair rather than arbitrary.
- **Curated content stays free.** The hero "Which AI is best?" debate, showcase debates, Explore page browsing, reading and voting on existing runs — all free. No API calls triggered by the user, no cost to the site. This is the funnel.
- **Tip jar / Support the Lab:** Always available. Some people will just give money because they like what you're doing. Zero friction to add.
- **Later extensions:** Additional models (DeepSeek, Kimi, Qwen) as a token-priced feature. Tournaments with token entry fees. Embedded challenges for external sites as a B2B offer.

**Launch protection — non-negotiable:**

- **Hard monthly API budget ceiling in code.** If total debates across all users exceed the cap in a given month, the site refuses new free-tier runs and shows a friendly "we're at capacity today, try tomorrow" message. Paid token runs continue because they're self-funding. This is the solo-founder survival feature that protects against viral moments becoming bankruptcy events.
- Ship the cap logic with Debate v2 in Phase 1, not later.
- Start the free tier tight. Tightening after launch is painful; starting tight and loosening is easy.

**What the monetisation should not do:**

- Paywall the core experience. The free welcome grant must be genuinely usable.
- Rely on advertising. Incompatible with the lab brand.
- Gate the behavioural data itself. The observations are the product — they should be public.
- Chase growth metrics over engagement. A small engaged audience that spends is the target; a large free audience that doesn't is not.
- Expire tokens. Ever.

---

## What's uncertain

Things this roadmap assumes but hasn't verified:

- **Whether shipping Debate v2 and Territory War simultaneously dilutes the launch story or amplifies it.** Two formats at once is more to communicate but fundamentally repositions the site as a multi-format lab rather than a debate product. The roadmap bets on amplification. Phase 1 review should validate this.
- **Whether the Territory War strategy feedback UI actually produces legible insight for non-technical users.** The feature is the core lab-identity moment, but if users can't parse the per-turn reasoning log it fails as a hook. Usability testing before deployment is worth real time.
- **Whether users want non-debate challenges beyond Territory War.** Phases 3 and 4 assume appetite for additional formats. That assumption needs data from Phase 2 engagement before committing Phase 3 engineering time.
- **Whether monetisation converts at a sustainable rate.** The token model assumes meaningful conversion from the welcome grant to first purchase, plus some power-user whale behaviour. That's realistic for an engaged niche audience but not guaranteed. The Phase 2 boundary review should check actual conversion data before scoping Phase 3.
- **Whether the TypeScript backend stabilisation lands on time.** Everything in Phase 1 and beyond depends on this.

The roadmap should be revisited at the end of each phase with these uncertainties as the review agenda.

---

## Review cadence

- **End of Phase 1:** Is Debate v2 working for new users? Did Territory War land as a second format or feel grafted on? Is the Arena shell providing real value or decoration? Are users returning? Does the strategy feedback UI actually produce the "aha" moment the lab identity promises?
- **End of Phase 2:** Which debate variants got traction? Which Territory War extensions got used? Has monetisation started? Is the audience engaged enough to warrant new challenge formats?
- **End of Phase 3:** Did the new text challenges work as Arena formats? Did they bring new users or just entertain existing ones?
- **Before Phase 4:** Honest conversation about whether to go deep (The Investigation, Collaboration Triangle) or stay wide (more variants of what's working).

At each review, update this document. This is the single source of truth for the product direction — it should reflect reality, not the plan from three months ago.
