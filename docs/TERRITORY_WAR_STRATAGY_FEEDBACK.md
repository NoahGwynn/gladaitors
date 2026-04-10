A design brief for the Territory War strategy feedback UI — the per-turn display that shows each model's stated reasoning alongside their actual actions. This is the feature that turns Territory War from "a game you watch" into "an observation of how three models reason and act." It is the single most important piece of lab-identity work in Phase 1 of the Roadmap.

---

## Why this feature matters

The lab's core promise is:

> _See what frontier AI models actually do when you put them in structured situations — and why they say they did it._

Everything else on the site is infrastructure around that sentence. The strategy feedback UI is where that promise gets delivered, turn by turn, in Territory War. Without it, Territory War is a watchable game. With it, Territory War is an experiment.

The interesting content is always the **gap between stated intent and actual action**. A model that says it will move east to secure the ore deposit and then moves east to secure the ore deposit is a baseline. A model that says it will build a fort and doesn't — for two entire games, as ChatGPT did in the April 4 runs — is a finding. The UI's job is to make that gap instantly visible and legible to a non-technical viewer.

---

## What it shows per turn, per model

For each of the three models, each turn, the UI surfaces five things:

1. **Model identity** — colour, name, avatar. Consistent with the rest of the Arena.
2. **Stated intent** — a one-sentence distillation of the model's reasoning (max ~15 words). Example: _"Move unit 3 east to secure the northern ore deposit."_
3. **Actual action** — what the model did, in human language. Example: _"Moved unit 3 east to (12, 4)."_ Not raw JSON.
4. **Outcome** — a short badge or line describing what happened. Example: _"Gained 2 tiles. Adjacent to ore."_ or _"Move blocked — edge of map."_
5. **Alignment indicator** — did the action match the stated intent? Green tick (aligned), amber flag (partial), red flag (diverged), grey dash (no stated intent).

Everything else — full reasoning, raw prompt, token counts, latency — is available via progressive disclosure. Tap a turn to expand. Tap again to drill into raw model output. The default view is distilled.

---

## The reveal order

This is the most important UX decision in the brief and it's worth making intentionally.

**Recommendation: intent first, then action.**

When a turn is about to execute, each model's stated intent appears first — a brief reveal beat where the viewer sees _"Claude says it will move east to the ore deposit."_ Then the action executes on the map. Then the outcome resolves. Then the alignment indicator appears.

This order matters because it builds anticipation _and_ makes the gap legible. The viewer holds the stated intent in working memory while the action plays out. If the model does what it said, there's a satisfying confirmation. If it doesn't, the gap jumps out immediately because the viewer was primed to expect something else.

The alternative (action first, then intent) makes the gap feel like post-hoc explanation rather than broken expectation. It's less dramatic and less in line with the lab identity. Don't use it.

---

## Layout

### Desktop

The map remains the primary visual element. The strategy feedback UI sits beneath or beside it as a three-column stream — one column per model — with the current turn expanded and previous turns collapsed to single-line summaries above it.

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│                                                            │
│                    TERRITORY WAR MAP                        │
│                                                            │
│                                                            │
├────────────┬────────────┬────────────┬────────────┐
│ Turn 11    │ Turn 12    │ Turn 13 ▼  │  [Controls]│
├────────────┼────────────┼────────────┤            │
│ CLAUDE     │ GPT-4O     │ GEMINI     │   ⏸ Play   │
│ Intent:    │ Intent:    │ Intent:    │   ⏮ Prev   │
│ Move east  │ Claim more │ Cluster    │   ⏭ Next   │
│ to ore     │ territory  │ toward ore │            │
│            │            │            │   Speed:   │
│ Action:    │ Action:    │ Action:    │   1x  2x   │
│ Moved east │ Moved south│ Moved east │            │
│ to (12,4)  │ to (9,15)  │ to (14,5)  │            │
│            │            │            │            │
│ Outcome:   │ Outcome:   │ Outcome:   │            │
│ +2 tiles   │ +1 tile    │ +2 tiles   │            │
│            │            │            │            │
│ ✓ ALIGNED  │ ✗ DIVERGED │ ✓ ALIGNED  │            │
└────────────┴────────────┴────────────┴────────────┘
```

The current turn is expanded. Previous turns collapse into a timeline strip above showing just the alignment indicators across all turns so the viewer can scrub back and see patterns forming. Scrubbing back expands any prior turn inline.

### Mobile

The map shrinks to the top third of the screen. Below it, the three models become stacked cards — vertically scrollable, one model at a time visible if needed, or all three compressed into a compact row. The key constraint on mobile is that intent and action must both be visible without tapping. Outcomes and alignment indicators can be secondary.

A horizontal swipe between models gives an alternative navigation on small screens.

---

## Legibility principles

The single biggest risk with this feature is that it becomes a debug console — technically accurate, impossible to parse for a non-technical viewer. The following rules exist to prevent that.

**1. Distill, don't dump.** Every intent line is a distilled 15-word summary of the model's actual reasoning. Not the raw reasoning text. The raw text is available behind a tap, but the default is the summary. Distillation should be done at generation time (post-process the model's reasoning into a short intent line) or at render time (use a cheap fast model like Haiku to summarise) — whichever is simpler to build.

**2. Translate actions into English.** _"Moved unit 3 east to (12, 4)"_ is better than `*{"unit": 3, "action": "move", "direction": "east"}*`. _"Moved east toward ore"_ is better still, if it can be inferred from context. Always prefer the most human version the data supports.

**3. Use model colours consistently.** Every mention of a model, every card, every tick, every flag, uses the same colour. The viewer should be able to glance and identify which model is which without reading the label.

**4. One verb per turn per model.** The default view never shows more than one action per model per turn, even if the model took multiple actions. Multi-action turns collapse to _"Moved and built fort"_ or similar. Full action list is behind a tap.

**5. Alignment indicators are binary-feeling, even though they're three-state.** Green tick is good. Red flag is bad. Amber flag is unusual and draws the eye. Grey dash is neutral. The viewer should feel something about each indicator within half a second of seeing it.

**6. Previous turns collapse aggressively.** A 30-turn game cannot show 30 expanded turn cards. The timeline strip is the default view for history; individual turns expand on demand.

---

## What the alignment indicator actually measures

The alignment indicator is not just decoration — it's the mechanism that turns every turn into a data point. Across all runs, alignment rates become the per-model consistency score shown on the behaviour dashboard in Phase 2. That dashboard is the lab's headline data artefact.

**How alignment is judged:**

Start simple. Rule-based comparison of stated intent keywords against actual action:

- Does the intent mention a direction? Does the action move in that direction?
- Does the intent mention a target (resource, enemy, location)? Does the action move toward it?
- Does the intent mention an action type (attack, build, harvest)? Does the actual action match?

If any keyword match succeeds, mark aligned. If the action contradicts the intent, mark diverged. If the intent is vague or the action is orthogonal, mark partial.

**Upgrade path:**

Once the rule-based version is live and proven, consider replacing it with a cheap LLM-based judgment (Haiku or similar) that reads the full reasoning text and action log and returns a one-sentence explanation of alignment. That's more expensive but more accurate, and the explanation becomes additional content on the expanded turn view. Worth building once the base format is shipping and there's actual user feedback on where the rule-based judgment feels wrong.

**Important:** the alignment judgment is a claim the site is making publicly, about frontier AI models, in full view of users. It needs to be defensible. When in doubt, mark partial rather than diverged. False claims of misalignment are worse than generous claims of alignment.

---

## What this feature is NOT

- **Not a debug console.** Raw prompts, tokens, schema validation errors, latency traces are engineering data. They belong in an internal view for the producer tool, not in the public UI.
- **Not a full reasoning dump.** The full reasoning text is available behind a tap. It is never the default view.
- **Not real-time commentary.** The UI does not narrate, editorialise, or explain. It shows intent, action, outcome, alignment. Commentary is a separate possible feature for later.
- **Not gamified with fake drama.** No sound effects on a divergence. No exploding animations. The drama is inherent in the data — the UI's job is to stay out of its way.
- **Not a scoreboard.** The scoreboard is elsewhere on the page. The feedback UI is about reasoning, not scores.

---

## Open questions

1. **Where does intent distillation happen — at generation time or at render time?** Generation time is simpler but locks the distillation to whatever the model's reasoning produced. Render time (a post-hoc summarisation) is more flexible but adds API cost per turn. Default recommendation: start with render-time summarisation using a cheap model, upgrade if cost becomes an issue.
2. **Should previous turns be fully scrubbable, or only collapsed/expanded?** Scrubbing back to turn 4 and watching from there is more powerful but adds meaningful engineering cost. Start with expand/collapse only.
3. **Do users need a "playback speed" control during live watches?** Probably yes for archived runs, probably no for live ones. Defer until after deployment.
4. **On mobile, do the three model cards stack vertically or swipe horizontally?** Both work. User testing will answer this. Default recommendation: vertical stack, because horizontal swipes compete with the map's native pan/zoom gestures.
5. **How does this feature interact with the producer tool (OBS, overlays) used for recording sessions?** The producer tool currently has its own view. This brief is for the public Arena view. The two may share components but are not the same surface. Confirm this is the correct scope before building.

---

## Success criteria

Before shipping, the feature should pass these tests:

- **The 10-second test.** A new visitor lands on a Territory War run mid-way through. Within 10 seconds they understand that three AI models are playing, that each model has stated intentions, and that those intentions sometimes don't match their actions. No tutorial required.
- **The screenshot test.** A single screenshot of a diverged turn — Claude says one thing, Claude does another — is legible and compelling as a social post. If the screenshot needs a caption to explain what's happening, the UI has failed.
- **The mobile test.** On a phone, the intent and action are both visible without scrolling. The alignment indicator is recognisable at a glance. The viewer can scrub through the match without the map becoming unusable.
- **The non-technical test.** Show the UI to someone who knows what AI is but has never used an API. They should be able to describe what Claude did on turn 14 and whether it matched what Claude said. If they can't, the distillation isn't working.

All four tests should pass before deployment. If any of them fail, iterate before shipping rather than shipping and hoping.

---

## Dependencies and sequencing

This feature depends on:

- Territory War game engine running in TypeScript (done or in progress)
- Per-turn logging of both reasoning and actions to a structured format (exists — the April 4 logs show this)
- Arena sub-page shell for Territory War (in progress)
- Distillation pipeline for intent summaries (not yet built — new work)
- Alignment judgment logic (not yet built — new work)

This feature blocks:

- Territory War deployment as Arena sub-page
- The behaviour dashboard in Phase 2 (which aggregates alignment data across runs)
- Any future challenge that wants to reuse the same reasoning-vs-action visualisation pattern (Prisoner's Dilemma, Collaboration Triangle, The Investigation — all of these will benefit from a working version of this UI)

Because this feature blocks Phase 2 work and is the core lab-identity moment, it is worth investing real time to get right. A rough target: 2–3 weeks of focused build, including the distillation pipeline and the alignment logic. Longer than that suggests scope creep; shorter than that probably means corners are being cut on legibility.
