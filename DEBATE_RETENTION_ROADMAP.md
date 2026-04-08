# Debate Arena — Retention Roadmap

Ordered by impact-to-effort. Build top-down.

---

## 1. Audience Voting — "Who Won?"

**Priority: Critical — build first**

Add a vote prompt at the bottom of every debate (both creator view and shared view). Users pick which model they think won. Show aggregate results after voting.

- Single `votes` table (debate_id, voter_id/session_id, model_id)
- One vote per viewer per debate
- Display as horizontal bar chart after voting
- Unlocks leaderboard data downstream ("Claude wins 62% of debates")

**Why:** Without this, debates have no resolution. The experience ends with the last argument and there's no reason for viewers to engage. Voting turns passive readers into participants and gives creators a reason to share.

---

## 2. Notifications on Shared Debates

**Priority: High — closes the re-engagement loop**

When a shared debate gets views or votes, notify the creator:

- "Your debate has been viewed 47 times"
- "63% think Claude won your debate"
- Email digest (daily or weekly, not per-event)
- Optional in-app notification badge on the history sidebar

**Why:** Currently there's zero reason to return after generating a debate. Every view and vote on a shared debate is a missed pull-back opportunity. This is what turns a one-shot generator into something people check on.

---

## 3. Follow-Up Rounds — "Continue This Debate"

**Priority: High — low-friction monetisation**

After a debate ends, offer: "Add 2 more rounds for X tokens?"

- Resume functionality already exists in the codebase
- Small incremental token cost (e.g. 3-4 tokens for 2 extra rounds)
- User is already invested in the outcome — conversion is natural
- Free 3-round debates convert into paid extensions without a hard paywall

**Why:** The moment someone finishes reading a debate and thinks "I wish they'd gone deeper" is the highest-intent moment to convert. Meet them there.

---

## 4. Debate Templates and Trending Topics

**Priority: Medium — reduces friction on repeat usage**

The blank form is the enemy of the second debate. Add:

- **Templates:** Pre-built topic + position combos users can launch with one click
  - "Is AI art real art?"
  - "Tabs vs spaces"
  - "Should we colonize Mars?"
  - Rotate regularly to keep it fresh
- **Trending:** Show what other people are debating this week (aggregated topics, not private data)
- **Remix:** Button on any shared debate to re-run the same topic with different models or positions

**Why:** Most users have one debate idea in them. Templates and trending topics provide the spark for the second, third, and fourth. That's where retention lives.

---

## 5. Weekly Digest — "This Week's Best Debates"

**Priority: Medium — content marketing + re-engagement**

Auto-rank debates by votes and views each week. Curate a top 5-10.

- Send as email to opted-in users
- Post on social channels (Twitter, Reddit)
- Feature on the site homepage or a dedicated "Featured" section

**Why:** Dual purpose — pulls existing users back with interesting content, and acts as organic marketing for new users. Each featured debate is a shareable piece of content with a built-in CTA.

---

## 6. Public User Profiles

**Priority: Medium-Low — adds identity and status**

Make debate history optionally public. Let users build a profile.

- Display name, total debates run, total votes received
- Gallery of their public debates
- "Debate creator" as a lightweight identity
- Optional — users can keep debates private by default

**Why:** Where there's visible status ("This person has run 34 debates"), there's retention. Public profiles also make sharing more personal — you're not just sharing a debate, you're building a reputation.

---

## 7. Debate Series / Tournaments

**Priority: Low — power user feature**

Let users set up structured multi-debate formats:

- **Best of 3:** Same topic, 3 separate debates, overall winner by vote
- **Round robin:** Every model pair debates the same topic
- **Topic ladder:** Escalating difficulty or controversy across debates

Costs more tokens, rewards power users with richer content.

**Why:** Gives heavy users a reason to spend more tokens in a single session and creates more substantial shareable content. Build this once there's evidence of repeat users who want depth.

---

## Summary

| # | Feature | Effort | Impact | Builds on |
|---|---------|--------|--------|-----------|
| 1 | Audience voting | Low | Critical | — |
| 2 | Notifications | Low-Med | High | Voting |
| 3 | Follow-up rounds | Low | High | Existing resume logic |
| 4 | Templates + trending | Medium | Medium | Voting data |
| 5 | Weekly digest | Low | Medium | Voting + templates |
| 6 | Public profiles | Medium | Medium-Low | History |
| 7 | Tournaments | High | Low | Everything above |
