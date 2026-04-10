# gladaitor — Sticky Features Roadmap (Debate Section)

These are the features that turn the debate arena from a one-shot tool into a
platform people return to. Listed in build order. Each item is self-contained —
read only the section you're working on.

**Working principles for everyone building these:**

- Strip back and rebuild rather than patch and accumulate technical debt.
- Fully understand the existing context before changing anything. Read the relevant
  files end-to-end, don't pattern-match.
- Don't add features the user didn't ask for. Don't add error handling for
  scenarios that can't happen. Don't speculate on future requirements.
- One feature at a time. Finish it cleanly before moving on.
- Commit before any structural change (OneDrive locks files; failed renames cause data loss).

---

## Build order

1. Voting
2. Refactor debate API to one-round-per-call
3. AI auto-assign position (standalone — works for any debate)
4. User as a debater participant
5. Extend / continue debates with optional moderator note
6. Notifications
7. Public feed opt-in + listing

---

# 1. Voting

**Why:** Without a vote, every debate has no resolution. Voting turns passive readers
into participants and gives creators a reason to share. It's also the foundation for
leaderboards and the public feed — same `votes` table powers everything.

## Decisions made

- **Scope of votes:** "Who won?" — single vote per viewer per debate. Not per round, not
  per category. Keep it simple.
- **Visibility:** Results hidden until the viewer votes. Prevents anchoring bias.
  After voting, show the bar chart with their selection highlighted.
- **One vote per viewer:** logged-in users by `user_id`, anonymous viewers by `session_id`.
- **Cross-content:** the `votes` table is keyed by `(content_id, content_type)` so the
  same infrastructure works for debates, future games, and any other content.
- **Anyone can vote:** you don't need to own the debate, you just need the link.

## Database

```sql
create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null,
  content_type text not null,        -- 'debate' for now, 'game' later
  voter_user_id uuid references public.profiles(id),
  voter_session_id text,
  voted_for text not null,           -- the debater_index as text, or model_id
  voted_at timestamptz not null default now()
);

-- One vote per viewer per content
create unique index votes_unique_user
  on public.votes(content_id, content_type, voter_user_id)
  where voter_user_id is not null;
create unique index votes_unique_session
  on public.votes(content_id, content_type, voter_session_id)
  where voter_user_id is null and voter_session_id is not null;

-- Index for fast aggregation
create index votes_by_content
  on public.votes(content_id, content_type);

alter table public.votes enable row level security;

create policy "Anyone can read votes"
  on public.votes for select using (true);

create policy "Anyone can cast votes"
  on public.votes for insert with check (true);
```

Helper function for atomic check-and-cast:

```sql
create or replace function public.cast_vote(
  p_content_id uuid,
  p_content_type text,
  p_user_id uuid,
  p_session_id text,
  p_voted_for text
) returns boolean as $$
begin
  insert into public.votes (content_id, content_type, voter_user_id, voter_session_id, voted_for)
  values (p_content_id, p_content_type, p_user_id, p_session_id, p_voted_for)
  on conflict do nothing;
  return found;
end;
$$ language plpgsql security definer;
```

## API

- `POST /api/votes` — body: `{ contentId, contentType, votedFor }`. Reads auth or
  `x-session-id` header. Returns `{ success: true }` or 409 if already voted.
- `GET /api/votes?contentId=...&contentType=...` — returns aggregate counts and
  whether the current viewer has voted: `{ counts: { "0": 12, "1": 3 }, votedFor: "0" | null }`

## Frontend

- New component: `VotingPanel.tsx`
  - Props: `contentId`, `contentType`, `options` (debater list with display names + colours)
  - State: loading, hasVoted, counts, selectedVote
  - On mount: fetches current vote status
  - Before vote: shows "Who won?" + buttons (one per debater)
  - After vote: shows horizontal bar chart with the user's choice highlighted
- Renders at the bottom of:
  - The completed debate view in `app/arena/debate/page.tsx` (after `postDebate` block)
  - The shared debate view in `app/arena/debate/[id]/SharedDebateView.tsx`

## What this does NOT do (yet)

- No leaderboards. That's a separate later feature.
- No vote-per-round. Single overall vote.
- No "agree/disagree with positions" — only "who argued best."
- No notifications when your debate gets votes. That's feature #5.

## Effort: ~1-2 days

---

# 2. Refactor debate API to one-round-per-call

**Why:** Required foundation for features #3 (user participation) and #4 (extending).
The current API runs the entire debate as one streaming response. Adding user turns
mid-stream is fragile. One round per API call is cleaner, supports user turns naturally,
and makes "extend by N rounds" trivial.

This is pure refactoring — no user-visible change. The streaming UX inside a round
stays exactly the same.

## Decisions made

- **One API call per round, not per turn.** Within a round, the AI debaters still go
  sequentially in one streaming response. The pause point is _between_ rounds.
- **Frontend orchestrates the round loop.** After each round ends, the frontend either
  triggers the next round automatically, or pauses to wait for user input (feature #3),
  or stops because the debate is complete.
- **No change to SSE event types.** `thinking`, `token`, `argument`, `model_error`,
  `insufficient_tokens`, `done` all stay. Add one new event: `round_complete`.
- **Token deduction stays per-argument.** A failed model still costs 0 tokens. The
  refactor only changes call boundaries, not billing.
- **Resume logic survives.** The existing `existingArguments` + `startRound` + `skipModels`
  parameters become the only mode of operation — every call passes them. The API treats
  every request as "continue from this state" even on the first round (where the state
  is empty).

## API changes

`POST /api/debate` becomes:

- Input: `{ topic, debaters, rounds, context, revealIdentities, existingArguments, currentRound }`
- Behaviour: runs ONLY `currentRound`. Skips debaters whose argument for `currentRound`
  already exists in `existingArguments`. Streams the round's tokens. Closes the stream
  with `round_complete` once the round is done.
- The route does NOT loop through rounds anymore. That logic moves to the frontend.

Safety check still happens, but only on the first round (when `existingArguments` is empty).

## Frontend changes

`generateDebate()` and `continueDebate()` collapse into one orchestration loop:

```ts
async function runDebate(initialState) {
  let state = initialState;
  while (state.currentRound <= state.totalRounds && !state.cancelled) {
    await runRound(state);
    state.currentRound += 1;
  }
  markDebateComplete(state);
}
```

Each `runRound` is an SSE call to the API. The user-participation hook (feature #3)
will go BETWEEN rounds, before the next one starts.

## What this does NOT do

- No new user-visible features. This is purely structural.
- No change to the database schema.
- No change to safety checks, rate limiting, or token deduction logic.

## Effort: ~2-3 days

---

# 3. AI auto-assign position

**Why:** A standalone feature that works for any debate, with or without humans.
Right now users have to type a position for every AI debater. With auto-assign, they
can let the AI pick its own stance — useful when they don't know what positions to
suggest, or when they want to see what each model would naturally argue. It's also
the foundation for the most interesting variant of feature #4: "the AI doesn't know
it's debating a human AND doesn't know what stance to take."

## Decisions made

- **Per-debater toggle.** Each debater card has a small "Auto" toggle next to the
  position input. Off (default) = manual position entry, current behaviour. On =
  AI picks its own stance.
- **Resolution timing.** The AI's stance is generated ONCE before round 1 starts,
  via a quick pre-call to that same model. The generated position is then frozen
  for the rest of the debate (so all rounds see the same stable positions).
- **Cost.** Free to the user. The pre-call costs us a few tokens of API time.
- **Persistence.** Resolved positions are written into the debate record's `positions`
  jsonb under the same index-keyed format. Replays and shared links see the final
  positions, not the empty originals.
- **The pre-call prompt.** Sent to the same model that will be the debater:
  > "You are about to debate the topic '<topic>'. Other debaters have taken these
  > positions: <list>. What stance would you take? Reply with a single short
  > sentence — your assigned position only, no preamble."
- **Anonymous mode interaction.** When `revealIdentities` is off, the auto-assign
  pre-call also hides opponent identities ("Other debaters argue: 'X' and 'Y'").
  The model picks its stance without knowing who else is at the table.
- **User as auto.** Not allowed — auto-assign only applies to AI debaters. The
  toggle is hidden when the slot is set to a `'user'` model.

## Database

`positions` jsonb continues to store the final position strings. No schema change
required. The debate record is updated in-place when positions resolve.

## API changes

A new helper function in the debate route runs at the start of every API call where
`currentRound === 1` and `existingArguments` is empty:

```ts
async function resolveAutoPositions(debaters, topic, revealIdentities, supabase, debateId) {
  for (each debater with assignmentMode 'auto' and empty position) {
    const stance = await generateStanceFor(debater, topic, debaters, revealIdentities);
    debater.position = stance;
  }
  // Persist resolved positions back to the debate record
  await supabase.from('debates').update({ positions: ... }).eq('id', debateId);
}
```

The pre-call uses the same provider streamers but with a tiny `max_tokens` (~50)
since we only want one sentence back.

## Frontend changes

- `DebaterConfig` gets a new field: `assignmentMode: 'manual' | 'auto'` (default `'manual'`)
- Debater card renders an "Auto" toggle. When on:
  - The position input is replaced with a muted placeholder: "AI will pick its own stance"
  - The position input is disabled (no manual entry)
- Validation: a debater is valid if either `assignmentMode === 'auto'` OR `position` is
  non-empty. So an auto debater doesn't block the form.
- When the form is submitted, `assignmentMode: 'auto'` debaters are sent with empty
  positions. The API resolves them.
- After round 1 starts, the auto-resolved positions appear in the debate header and
  argument cards via the normal flow (the positions are now populated in `activeDebate.debaters`).

## Edge cases

- **All debaters set to auto.** Allowed. The AIs collectively figure out who's arguing
  what. Most interesting in anonymous mode.
- **Auto-assign fails (model errors).** Show a clear error and let the user pick manually.
  Do not silently fall back to a placeholder.
- **Auto-assign produces an empty or near-empty stance.** Treat as a fail and ask the
  user to edit manually.
- **Resume from incomplete auto-assigned debate.** The positions are persisted, so
  resume reads them as normal — no re-resolution.

## What this does NOT do

- Doesn't allow editing the auto-assigned stance after generation. Once it's resolved,
  it's locked for the debate.
- Doesn't show the user a preview of the auto-assigned stance before round 1 starts.
  The first round itself reveals it.

## Effort: ~1-2 days

---

# 4. User as a debater participant

**Why:** This is the killer feature. "I argued against Claude and won" is identity-level
content — it gets screenshotted, shared, and bragged about. The product becomes personal.

## Decisions made

- **The user is a slot like any other debater.** A new model entry with `id: 'user'`,
  `family: 'user'` joins the registry. Position assignment, display name disambiguation,
  anonymous mode — all reuse existing patterns.
- **Multiple user slots are allowed.** A user can put themselves in two slots if they
  want (e.g. play both sides of a debate, or two people sharing one screen). Same
  duplicate-handling logic as duplicate AI models.
- **Naming.**
  - In the model picker dropdown: shown as **"Me"** (the user picking themselves).
  - In AI prompts and the debate display: shown as **"Human"** (single user) or
    **"Human 1" / "Human 2"** (multiple users). This avoids the "You" collision —
    AI prompts use "You" as the model's own self-label, so labelling the user as
    "You" too would be ambiguous.
  - The "Human vs AI" framing is also exactly what makes the feature compelling.
  - Future polish: optional name field so users can type "Noah" instead.
- **Token cost: 0 for user turns.** The user isn't consuming an AI call. Total debate
  cost = `rounds × sum of AI debater token costs` (excluding user slots).
- **User input UI.** Appears between rounds when it's a user slot's turn. Textarea
  with soft 250-word hint. No edit-after-submit. Shows the user's assigned position
  above the textarea so they remember.
- **No time limit on user turns.** Debates aren't real-time.
- **Safety check on user arguments.** Same Gemini classifier we use for topic safety,
  adapted to "would you publish this argument on a debate platform?" If blocked, show
  inline error and let the user edit and retry.

## Database

Add `'user'` as an allowed `model_id` value. The existing `models` text[] and
`positions` jsonb structures already tolerate this — no schema change needed.

## API changes

The round-by-round handler:

- Skips any debater whose family is `'user'` when iterating debaters in a round —
  the frontend is expected to have already injected the user's argument into
  `existingArguments` before calling the API.
- Token deduction loop ignores user slots (their `tokenCost` is 0 anyway).
- Auto-assign (feature #3) does not apply to user slots — they always have a manual
  position.

A new helper endpoint or inline validation runs the safety check on user-submitted
arguments before they're added to the conversation. If the check fails, the API
returns 400 with the reason.

## Frontend changes

- Add a `'user'` model entry to the registry: `{ id: 'user', family: 'user', name: 'Me',
tokenCost: 0, providerModelId: '' }`. Family colour: gold (`$ui-gold`).
- The model registry's `family` enum gains `'user'`.
- `getDisplayNames` special-cases the user family: base label is "Human" instead of
  the registry name, with the same numbering rule for multiples.
- `ModelSelect` already shows everything in the registry — works for free.
- Round orchestration: BEFORE running each round, the frontend checks if any user
  slot needs input for this round. If yes, render `UserTurnInput` and wait for submit
  before calling the API.
- `UserTurnInput` component:
  - Textarea with placeholder
  - Soft 250-word counter
  - Submit button (disabled while submitting / safety-checking)
  - Shows the user's assigned position above the textarea
  - Inline error display for safety check failures
- After user submits, the frontend:
  1. Sends the argument text to a safety check endpoint
  2. If safe, pushes a synthetic "argument" into the live state with `model_id: 'user'`,
     `model_name` set to the user's display label, and the user's content
  3. Saves the argument to the debate record
  4. Continues the round (if other debaters still need to go) or moves to the next round

## Edge cases to handle

- **User abandons mid-debate:** existing "Continue Debate" button works. The orchestrator
  resumes from the user's input prompt when they come back.
- **User submits something the safety check blocks:** inline error shown, edit + retry,
  no tokens lost.
- **User submits empty/whitespace:** validation prevents submission.
- **Multiple user slots in one debate:** handled by the duplicate-disambiguation logic.
  Each `'user'` slot gets its own input prompt in turn.
- **All slots are user slots:** allowed but probably uninteresting. The orchestrator
  would just walk through user prompts with no AI calls between them.
- **Auto-assign + user slot in same debate:** auto-assign skips user slots, applies
  only to AI ones.

## What this does NOT do

- No real-time multiplayer between two browser sessions — multiple user slots all
  happen on the same screen.
- No voice input, no image attachments. Text only.
- No edit-after-submit on user arguments.
- No "AI grades my argument" feature.

## Effort: ~3-5 days

---

# 5. Extend / continue debates with optional moderator note

**Why:** The moment someone thinks "I wish they'd gone deeper" is the highest-intent
moment to convert. After feature #2 lands, this is mostly free — extending is just
"add more rounds and run them."

## Decisions made

- **Hard cap: 15 total rounds.** Simple, predictable. Most debates won't hit it. Can
  raise later if data shows demand.
- **Extend modal:** appears after a completed debate. Shows:
  - "Add how many more rounds?" — slider/buttons for 1, 2, or 3 (capped by remaining
    rounds before the 15 limit)
  - Optional textarea: "Add a moderator note to redirect the discussion"
  - Optional toggle: "Join the debate as a participant from here on" (jumps into feature #4
    behaviour for the new rounds only)
  - "Extend Debate" button shows the token cost
- **Moderator notes are free.** They don't generate an AI response on their own — they're
  just context for the next AI argument.
- **Moderator notes are part of the debate record.** Stored as a special argument with
  `model_id: 'moderator'` and `refused: false` so they show inline in the thread.
  Display style is distinct (italic, centered, no model border).
- **Round numbering continues:** if the original was 3 rounds and you add 2 more, the
  new ones are rounds 4 and 5. The "Closing Statements" label moves to the new final round.

## Database

Moderator notes use the existing `arguments` jsonb on the debate. Add a new arg with:

```ts
{
  debater_index: -1,           // sentinel value
  model_id: 'moderator',
  model_name: 'Moderator note',
  round: <round being added>,
  content: <user's note>,
  refused: false,
}
```

The round count on the debate record updates when extended.

## API changes

- The round-by-round API (feature #2) already handles arbitrary continuation. Extending
  is just calling it with a higher `currentRound` than originally specified, plus the
  moderator note injected into `existingArguments`.
- Moderator notes are passed to AI models in `buildTurnPrompt` with a clear label:
  `"\nModerator note: <text>\n"` — distinct from debater arguments.

## Frontend changes

- Add `ExtendDebateModal.tsx` triggered from a button in the post-debate panel.
- Render moderator notes inline in the thread with distinct styling.
- After extending, the "Continue Debate" loop runs the new rounds.

## What this does NOT do

- No branching/forking debates. Extension is linear.
- No "swap models mid-debate." Same models throughout.
- No undo on extension. Once tokens are spent, they're spent.
- Round cap is hard at 15. No paid override for now.

## Effort: ~1-2 days (most logic comes from features #2 and #4)

---

# 6. Notifications

**Why:** Every view and vote on a shared debate is a missed pull-back opportunity
without this. Closes the re-engagement loop.

## Decisions made

- **Channels:** in-app badge in the nav, optional email digest (daily or weekly).
  No push notifications, no per-event emails (too noisy).
- **What triggers notifications:**
  - Vote received on a debate you created
  - View milestones on a shared debate (10 views, 50, 100, 500)
  - Anonymous → registered user link: when an anonymous debate gets activity after
    the creator signs up, they get a "your debate has been gaining traction" notification
- **What does NOT trigger notifications:**
  - Your own activity
  - Activity on debates you only viewed (not created)
- **Email opt-in:** off by default. User enables in account settings (which we'll need
  to build a minimal version of).

## Database

```sql
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,                      -- 'vote_received', 'view_milestone'
  content_id uuid,                         -- debate id
  content_type text,                       -- 'debate'
  data jsonb,                              -- vote count, view count, etc.
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index notifications_unread on public.notifications(user_id, read) where read = false;
create index notifications_recent on public.notifications(user_id, created_at desc);
```

Email preferences add to `profiles`:

```sql
alter table public.profiles add column if not exists email_digest text default 'off';
-- 'off' | 'daily' | 'weekly'
```

## API

- `GET /api/notifications` — returns unread + recent for current user
- `POST /api/notifications/read` — marks all (or specific) as read
- `POST /api/notifications/preferences` — updates `email_digest` preference

## Triggering

- Vote endpoint (feature #1) inserts a notification for the debate creator if the
  voter is not the creator.
- View counting: increment a `view_count` column on the debate when it's loaded
  (debounced server-side per session). When it crosses a milestone, insert a
  notification.
- Email digest: cron-driven (Vercel Cron or Supabase scheduled function). Reads
  unread notifications grouped by user, formats an email, sends via Resend or
  similar.

## Frontend changes

- Nav: add an unread count badge next to the user menu trigger
- Add a notifications dropdown panel in the nav menu
- Account settings page (minimal): just the email digest preference for now

## What this does NOT do

- No real-time push notifications (no WebSocket subscriptions).
- No SMS, no browser notifications API.
- No notifications for "X happened in a debate you commented on" — there are no
  comments.
- No notifications for new debates from people you follow — there's no follow system.

## Effort: ~3-5 days

---

# 7. Public feed opt-in + listing

**Why:** The privacy model decision was: all debates accessible by link, but NOT
shown in any public feed unless the creator opts in. This builds the opt-in toggle
and the feed itself.

## Decisions made

- **Default state:** all debates are unlisted. Accessible by direct link to anyone.
  Not shown in any listing.
- **Opt-in:** "List in public feed" toggle on the debate. Available after the debate
  completes (you can't list an empty debate). User can toggle on or off at any time.
- **The public feed:** new page at `/explore` (or similar). Shows recent and
  popular listed debates. Sortable by recency, votes, views.
- **Anonymous debates can also be listed**, but only after the creator signs up
  (anonymous content is ephemeral by default — you can't list a debate that might
  expire in 30 days).

## Database

Add to `debates`:

```sql
alter table public.debates add column if not exists is_public boolean not null default false;
create index if not exists debates_public on public.debates(is_public, created_at desc) where is_public = true;
```

## API

- `POST /api/debates/[id]/visibility` — body: `{ public: boolean }`. Owner only.
- `GET /api/debates/public?sort=recent|votes|views&limit=20&offset=0` — public feed
  query. No auth required.

## Frontend changes

- "List in public feed" toggle on the post-debate panel and the shared debate view
  (visible only to the owner).
- New page `/explore` showing the public feed.
- Card layout: topic, debater names with colours, vote counts, view counts, age.

## What this does NOT do

- No moderation queue. Public listings are subject to the same safety check that
  blocked the debate from being created in the first place.
- No reporting flow. Add later if abuse becomes an issue.
- No personalised feed. Same feed for everyone.

## Effort: ~2-3 days

---

# Summary

| #   | Feature                          | Effort   | Depends on         |
| --- | -------------------------------- | -------- | ------------------ |
| 1   | Voting                           | 1-2 days | nothing            |
| 2   | API refactor (round-per-call)    | 2-3 days | nothing            |
| 3   | AI auto-assign position          | 1-2 days | #2                 |
| 4   | User as participant              | 3-5 days | #2                 |
| 5   | Extend debates + moderator notes | 1-2 days | #2, #4             |
| 6   | Notifications                    | 3-5 days | #1                 |
| 7   | Public feed opt-in               | 2-3 days | nothing (any time) |

**Total: ~2-3 weeks of focused work.**
