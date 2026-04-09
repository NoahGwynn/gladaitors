# Debate Page Hero / Empty-State Refactor — Plan & Roadmap

**Status:** Not started. Planned to begin next session.

**Owner:** noah + Claude
**Last updated:** 2026-04-10

---

## TL;DR

The `/arena/debate` page has a configuration-first first impression. When there's no active debate, the right panel is a placeholder with an icon and instructional text — the largest visual area on the page does the least work. A first-time visitor sees a wall of form options before any value is demonstrated, doesn't know what kinds of questions the product is for, and has no way to get a feel for the output before committing.

This refactor fixes the **empty state of the debate page** by:

1. Replacing the right-panel placeholder with a real, curated **sample debate** rendered read-only, plus a marketing-strong headline and an "Example — pick a topic to make your own" indicator.
2. Adding **starter topic chips** below the topic input in the form panel, so the blank-page problem is solved by one click.
3. Reusing the same `EXAMPLE_TOPICS` list as the explore page for consistency.

**Critical scoping decision:** the change is **state-bifurcated, not user-bifurcated**. The hero treatment fires whenever there's no active debate (an "empty form" state), regardless of whether the viewer is new or returning. This means:

- Single layout codebase (no "new user" detection, no double maintenance)
- Power users still get the side-by-side form/debate view as soon as a debate is loaded or running
- Returning users see the hero whenever they reset / land fresh / hit "new debate" — a pleasant state, not an annoying instructional surface
- The active-debate side of the page is **completely unchanged**

---

## Why this exists

From the discussion:

- **Decision fatigue before the magic.** New visitors face ~8 form decisions before they can act. ChatGPT, Claude.ai, Perplexity, Midjourney all lead with value (a big input or a gallery) and treat configuration as secondary.
- **No demonstration of the product.** The whole pitch is "AI models argue each other" but the page never shows that until the user has clicked Start. A first-time visitor takes the entire value proposition on faith.
- **Blank-page problem.** "Configure your debate" assumes the user already has a question. Many don't.
- **The signup CTA is buried.** Top-right of the nav, easy to miss. The empty state could be doing conversion work.
- **Mobile makes it worse.** Form fills the viewport, placeholder is below the fold, first impression is pure configuration.

The root cause is **the right panel does no work in the empty state**. Fix that — leave the rest alone — and the first impression problem largely solves itself.

---

## What this refactor does NOT do

Things deliberately left out so the scope stays bounded:

1. **No layout overhaul.** The side-by-side form/debate split stays. Form panel on the left, content panel on the right. Only the *content* of the right panel in the empty state changes.
2. **No conditional UX based on user type.** Anonymous and logged-in users get the same layout. The signup CTA inside the hero treats anonymous visitors specially in copy, but the structure is identical.
3. **No progressive form disclosure.** Form fields stay visible. No wizard, no collapsing advanced options. Power users keep their workflow.
4. **No new schema.** Sample debate is a real existing debate row, fetched by id. No new tables, no migration.
5. **No A/B testing infrastructure.** Just ship one version. Iterate based on feel.
6. **No rotation / smart selection of sample debates.** One hardcoded id for v1. Followup #2 below covers rotation if we want it later.

---

## Goal architecture

### State machine for the right panel

```
                    ┌────────────────────────────────────────┐
                    │  Empty state (no active debate)        │
                    │                                        │
                    │  - Hero headline                       │
                    │  - Sample debate (read-only, marked    │
                    │    "Example", from a hardcoded id)     │
                    │  - "Pick a topic ↑" indicator          │
                    │  - Anonymous: signup nudge embedded    │
                    │                                        │
                    │  Triggered by: !activeDebate           │
                    └────────────────┬───────────────────────┘
                                     │
                                     │  user picks topic + Start
                                     │  user clicks history sidebar item
                                     │  user clicks starter topic chip
                                     ▼
                    ┌────────────────────────────────────────┐
                    │  Active state (current behaviour)      │
                    │                                        │
                    │  - Live debate thread                  │
                    │  - Voting panel                        │
                    │  - Post-debate actions                 │
                    │  - All existing flows unchanged        │
                    │                                        │
                    │  Triggered by: activeDebate set        │
                    └────────────────┬───────────────────────┘
                                     │
                                     │  user clicks "new debate"
                                     │  user clicks mobile back
                                     │  user resets
                                     ▼
                              (back to empty state)
```

The transition is binary on `activeDebate !== null`. No new flags, no new orchestrator state.

### Files affected

- **`app/arena/debate/page.tsx`** — replace the empty placeholder block with a hero component, add starter topic chips below the topic input, add a sample debate fetch effect
- **`app/arena/debate/page.module.scss`** — new classes for the hero, starter chips, and example marker
- **`lib/config.ts`** — add `sampleDebateId` constant (single source of truth, easy to swap)
- **`lib/debates.ts`** — add a `loadDebateById(id)` helper if one doesn't exist already (we already have `loadDebate` in the orchestrator that takes a `Debate` object — we need a fetch-by-id step that produces it)
- **`app/explore/page.tsx`** — extract `EXAMPLE_TOPICS` to a shared module so the debate page can reuse the same list (or duplicate it; see Open question 1)

### New components (optional extraction)

The hero could be inline in `page.tsx` or extracted into `components/DebatePageHero.tsx`. Recommendation: **keep it inline in `page.tsx` first**, extract only if the JSX gets unwieldy. Inline is faster to iterate and avoids prop-drilling for the form helper functions.

---

## Implementation plan — 4 commits

Each commit should leave the page in a working state. Manual test after each.

### Commit 1 — Shared starter topics + config

Small foundational commit so the explore page and the debate page both reference the same list and config.

- **Move `EXAMPLE_TOPICS`** from `app/explore/page.tsx` into a new `lib/starter-topics.ts` module exporting a single array. Both the explore page and the debate page import from there.
- **Add `sampleDebateId`** to `lib/config.ts` with a clear comment explaining what it's for and how to swap it.
- **No UI change yet** — the explore page just imports from the new module instead of declaring inline.

**Manual test:** explore empty state still renders the same starter topics. No regression.

### Commit 2 — Starter topic chips in the form

Add the topic-chip row below the topic input on the debate form.

- New JSX section directly under the topic input field, conditionally rendered when the topic input is empty (so it disappears once the user starts typing).
- Each chip is a click target that calls `setTopic(topic)` and focuses the topic input.
- Uses the same SCSS pattern as `.exampleCard` from the explore empty state — rounded pill, brand-color hover.
- Mobile: chips wrap naturally, full-width on very narrow screens.

**Manual test:** load `/arena/debate` fresh. Chips visible below the empty topic input. Click one — topic populates and chips disappear. Type your own topic — chips disappear. Clear the topic — chips reappear.

### Commit 3 — Sample debate fetch + hero render in the right panel

The biggest commit. Replaces the placeholder with the hero.

- **Add `fetchDebateById(id)`** to `lib/debates.ts` if not already present — calls supabase directly using the client (anon key + RLS handles read access for public debates).
- **In `page.tsx`:** add a `useState<Debate | null>(null)` for `sampleDebate` and a `useEffect` that fetches it once on mount. Cache in module-level memory if you want — or just refetch on every mount, it's one query.
- **Replace the `.debateEmpty` block** with a new hero structure:
  - Headline (`<h2>` styled): "Watch Claude, GPT-4o, and Gemini take sides on any question."
  - Subline: "Pick a topic on the left to start. Or read this example to see how it works."
  - "Example debate ↓" subtle marker
  - Render the sample debate's argument cards inline using the existing `.argument` styles from `page.module.scss` (the same renderer the in-arena view uses), wrapped in a `.exampleDebate` container with subtle visual differentiation
  - At the bottom of the example: a small CTA — *"Pick a topic on the left to start your own"* with an arrow pointing back to the form, OR a subtle signup nudge if anonymous
- **Fallback:** if the sample debate fails to load (deleted, network error, id not configured), fall back to a simpler text-only hero with the headline + a more prominent CTA. The page should never break because of a missing sample.

**Manual test:**
- Load `/arena/debate` fresh as anonymous → see hero + sample debate + signup nudge
- Load as logged-in → see hero + sample debate, no signup nudge
- Set sampleDebateId to an invalid uuid in config → see fallback hero, no console errors
- Create a new debate → empty state disappears, normal active-debate UI takes over
- Click "new debate" / mobile back / reset → empty state with hero re-renders
- Click history item → loads that debate, hero hides

### Commit 4 — Visual polish + mobile pass

Iterate on spacing, type sizing, and the Example marker. Likely small CSS-only.

- Verify on mobile that the hero is the right size — not so tall it's overwhelming, not so small it loses impact
- Verify that the sample debate's brand colors render correctly (left borders on argument cards)
- Verify the "Example" marker is clearly visible but doesn't dominate
- Tighten spacing on the headline / subline / sample / CTA stack
- Make sure the starter chips and the sample debate aren't visually competing — the chips are the action, the sample is the demonstration

**Manual test:** real device test on mobile + desktop, both wide and narrow viewports. Take a screenshot for comparison against the current state.

---

## Open questions to resolve during implementation

1. **Where does `EXAMPLE_TOPICS` live?**
   - Option A: new `lib/starter-topics.ts` (or `lib/example-topics.ts`) module — cleanest separation
   - Option B: add to `lib/config.ts` alongside `sampleDebateId` — fewer files but mixes concerns
   - **Recommendation: Option A.** Topics are content, config is settings. Keep them separate. Trivial extra file.

2. **Which debate to use as the sample?**
   - Hardcode one specific debate id in `config.ts`
   - The id must point to a high-quality, opinion-clear debate that demonstrates the product well
   - **Action item before commit 3:** noah picks a debate from his existing history and provides the id
   - The debate doesn't need to be marked public if we use a direct supabase fetch with the anon key + RLS — the existing read policy `"Anyone can view debates"` allows any debate to be read by anyone, public flag or not. Verify this in the schema before relying on it.

3. **Render the sample with full markdown / arguments, or a stripped preview?**
   - Full render is more impressive but takes vertical space
   - Stripped preview (first arg from each debater?) is more compact
   - **Recommendation: full render.** The point is to demonstrate the product. A truncated preview is just a longer version of the current placeholder. Vertical space is fine — the user can scroll, and the form panel stays sticky on the left.

4. **Should the hero be visible on the active-debate state too?**
   - Probably not. Once there's a real debate, the user wants to see THAT, not an example.
   - The hero is bound to `!activeDebate`.

5. **Caching the sample debate fetch.**
   - Simplest: fetch on every mount. One small query, no caching layer.
   - Slightly better: module-level cache so the second mount in the same tab session reuses the result.
   - **Recommendation: no cache for v1.** It's a single query, costs nothing, and adds simplicity.

6. **What does the headline copy actually say?**
   - Current proposal: *"Watch Claude, GPT-4o, and Gemini take sides on any question."*
   - Subline: *"Pick a topic on the left to start. Or read this example to see how it works."*
   - These are placeholder words — noah may want to write the final copy himself. Can iterate during commit 4.

7. **Does the form panel need any changes besides the starter chips?**
   - Maybe make the topic input slightly taller / larger font on the empty state, to claim visual weight as the primary action target
   - Defer to commit 4 polish if it feels off

8. **Does the sample debate get marked visually as "Example"?**
   - Yes — needs a clear marker so users don't confuse it with their own work
   - Options: a "EXAMPLE" pill in the corner, a watermark, an italicized footer, a subtle background tint on the container
   - **Recommendation: a small uppercase "EXAMPLE" pill anchored to the top-right of the example container, plus a subtle background tint or border treatment to visually differentiate it from a "real" debate.**

9. **Mobile layout: where does the hero appear on small screens?**
   - On mobile, the form panel currently fills the viewport and the right panel is below. So a first-time mobile visitor sees the form first, then the hero on scroll.
   - That might be OK because the starter chips (in the form panel) are right there.
   - Alternative: on mobile, render the hero ABOVE the form panel. Bigger change but maybe better marketing.
   - **Recommendation: leave the order as-is for v1.** The starter chips in the form panel are the immediate-action element on mobile, and the hero is right below for context. Test on a real device in commit 4 and revisit if it feels wrong.

10. **What happens when the sample debate's models are different from the user's defaults?**
    - The sample might be Claude vs GPT-4o, or Opus vs Gemini Pro, or anything else — depends on which one we pick
    - This is fine — the sample is illustrative, the user picks their own debaters in the form
    - No coupling between the two

---

## Recovery — if Claude crashes mid-refactor

This document is the source of truth for the plan. If a Claude session dies, a new session can pick up by:

1. **Read this document fully.**
2. **Run `git log --oneline -10`** to see how many commits have landed. Each of the four planned commits should have a recognizable subject line.
3. **Check `lib/config.ts`** for `sampleDebateId` — if present, commit 1 (or part of it) is done.
4. **Check `lib/starter-topics.ts`** — if present, commit 1 is done.
5. **Read `app/arena/debate/page.tsx`** — search for `starter` or `chip` to see if commit 2 has landed; search for `sampleDebate` or `exampleDebate` to see if commit 3 has landed.
6. **Resume from the next uncompleted commit.**

### Things to verify before resuming

- Is the current branch `master`? `git branch --show-current`
- Are there uncommitted changes from the previous session? `git status` — if so, decide whether to commit, stash, or discard
- Has noah provided a sample debate id? If not, ask for one before commit 3 — without it, commit 3 has nothing to render
- Has the explore page been verified to still work after the EXAMPLE_TOPICS extraction? Manual test of `/explore` with no debates should still show the starter chips

---

## Followups (deferred, not blockers)

These are real improvements that don't need to land in this refactor:

1. **Sample debate rotation.** Curate 3-5 strong debates and rotate randomly per page load (or per day). Better than a single sample because returning users get variety. Requires extending config from `sampleDebateId` (single string) to `sampleDebateIds` (array) plus a small selector. Defer until v1 ships and feels good.

2. **Smart sample selection.** Instead of hand-picked, pick the most-voted public debate of the past week dynamically. Requires `showSocialMetrics` to be on (it isn't yet) and meaningful traffic. Far-future.

3. **Topic input visual upgrade.** Larger, taller, with rotating placeholder text that cycles through topic examples. Adds personality. Could be its own small commit after the main refactor lands.

4. **Hero copy A/B test.** Once you have analytics, test variants of the headline against each other for conversion to first-debate-started. Needs analytics infra you may not have yet.

5. **Sample debate carousel.** Show multiple sample debates side by side so the user can flip between them. More effort, more impressive, defer.

6. **Animated demo.** Instead of a static sample debate, show one playing back token-by-token (cached, replayed at speed). Big effort. Defer.

7. **Personalised sample.** Once a logged-in user has created a few debates, show one of THEIR debates as the example instead of a generic curated one. "Your last debate" framing. Defer until there's enough creator history to make it interesting.

---

## Final commit graph (to be filled in as we land the work)

```
TBD — this section gets updated after each commit
```

Format:
```
abc1234 Commit 4 - Visual polish + mobile pass
def5678 Commit 3 - Sample debate fetch + hero render
ghi9012 Commit 2 - Starter topic chips in form
jkl3456 Commit 1 - Shared starter topics + config
```

---

## Notes from the discussion that led here

- noah's instinct was that the debate page first impression is underwhelming and confusing. That instinct was correct — the right panel doing no work in the empty state is the root cause.
- We considered three tiers of fix: quick wins, medium-effort sample debate, full hero migration. Settled on combining the three into a state-bifurcated approach because that's the cleanest answer.
- Critically rejected: "new users get hero, returning users get current layout." Two-layout maintenance is a tax forever, "new user" detection is unreliable, and inconsistency between visits erodes trust.
- The ChatGPT comparison comes up a lot. ChatGPT's interface IS hero-first and works for both new and power users. The lesson isn't "copy ChatGPT" — it's "the same layout can serve both groups well if designed deliberately."
- The active-debate state of the debate page is genuinely good and shouldn't be touched. The empty state is the only thing broken.
- noah explicitly said "we'll start this tomorrow" — this doc exists so the work can resume cleanly.
