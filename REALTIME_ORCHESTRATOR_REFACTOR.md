# Realtime Orchestrator Refactor — Plan & Roadmap

**Status:** Not started. Pre-refactor checkpoint committed at `dbaf6db... — site/dbaf6db^` (next commit after `dbaf6db Debate arena: auth, sharing, streaming, history, branding — pre-refactor backup`). **Look at `git log` for the actual hash of the pre-refactor checkpoint commit.**

**Owner:** noah + Claude
**Last updated:** 2026-04-09

---

## Why this exists

When a debate is running on `/arena/debate`, the entire sidebar (history, new debate, etc.) is disabled, because navigating away from the page tears down the orchestrator and kills the debate. This goes against user expectations from chatbots, where checking another conversation while the LLM responds is normal.

The actual cause: the round-by-round orchestrator lives inside the page component (`app/arena/debate/page.tsx`, ~1555 lines). When the page unmounts, React tears down the state, the in-flight `fetch` is aborted via React's effect cleanup, and the next-round POST never fires. There is no server-side loop to "take over."

The user wants:
1. In-app navigation should NOT kill the debate.
2. Multiple tabs / devices should stay in sync if viewing the same debate.
3. If a tab dies mid-debate, another tab/device should be able to take over.
4. Token-by-token streaming animation must be preserved for the active viewer.

---

## What we explicitly do NOT do (and why)

### 1. Server-side full-debate orchestration (was "Tier 3")

A single POST that runs the entire debate server-side. **Rejected** because:

- Human-in-the-loop debates require pausing for user input. The server cannot generate the human's argument. This forces a bifurcation between "AI-only orchestration loop on the server" and "client-driven loop with human pauses," which doubles the surface area of every shared concern (token deduction, persistence, refusals, model errors).
- Vercel function timeouts (~10s hobby, 60s pro, max ~5-15min) cap a single function lifetime well below a long human-debate.
- Workarounds (queue + worker — Inngest, Trigger.dev, QStash, Supabase Edge Functions with cron resumption, or self-hosted Node) are real engineering projects, not refactors.
- Token-by-token streaming becomes hard. Realtime/polling gives per-argument updates only. Building a separate ephemeral broadcast channel for active viewers is a second system to maintain.

### 2. Per-token persistence to Postgres

Writing to the DB on every token (~30/sec per debater) would hammer the database and feel laggy through the Realtime path anyway. Per-argument persistence is the right granularity.

### 3. Server-side coordination of cross-tab concurrent debates

Forcing single-debate-per-user across tabs would require a Postgres advisory lock or "user has active debate" flag. Token deduction is already atomic via the `deduct_*_tokens` RPC (no double-spend) and the IP rate limit (30 req/min) loosely caps concurrency. Power users may want concurrent debates across tabs. Not worth preventing.

### 4. Auto-resume on page refresh

The user previously asked to remove auto-loading the most recent incomplete debate on page load. Refresh = fresh session. This refactor does NOT change that. Resume happens via explicit "Take over" / "Continue" buttons, never automatically.

---

## Target architecture

### Three-layer model

1. **Orchestrator state** lives in a React Context Provider mounted in `app/layout.tsx` (or `app/arena/layout.tsx` if we want to scope it tighter). The provider survives all in-app navigation. The orchestrator loop, the user-turn Promise resolver, and the per-token state all live here.

2. **Persistence + status** lives in the Supabase `debates` table. The server-side API route writes per-argument and updates status flags as the loop progresses. The DB row is the cross-tab source of truth.

3. **Cross-tab sync** happens via Supabase Realtime subscriptions on the `debates` row. Every tab subscribed to a given debate id receives row updates within ~300ms. The DRIVING tab (the one that called "Generate") streams tokens via the existing direct SSE path; FOLLOWER tabs see argument-by-argument updates via Realtime.

### Lease ownership model

Only one tab "drives" a debate at a time. The driver writes its session id to `driver_session_id` and updates `driver_heartbeat_at` every 5 seconds while running.

- **Other tabs are followers.** They subscribe to the row read-only.
- **Stale lease** = `now() - driver_heartbeat_at > 15s`. Followers can claim a stale lease via the "Take over" button.
- **Take-over** = a follower explicitly claims the lease via an RPC. Only allowed when status is `awaiting_human` OR lease is stale. Disabled with a tooltip during active streaming.

### What each user sees

| State | Driver tab | Follower tab |
|---|---|---|
| `running` (mid-stream) | Token-by-token typing animation | Argument bubbles appear ~300ms after the driver finishes each one |
| `awaiting_human` (this user's turn) | Input box + submit | "Your turn — currently being typed in another tab. [Take over]" |
| `running`, fresh heartbeat, no human | "Round 3 of 5 — Claude is responding" | Same status text + arguments flowing in |
| Stale heartbeat (>15s) | n/a | "The other tab isn't responding — take over?" [Take over] |
| `complete` | Standard post-debate UI | Same |
| `error` | Error banner | Same |

---

## Design decisions (locked in)

### Q1. Take-over availability

**Decision:** "Take over" button is *visible* in non-driving tabs whenever the debate is loaded, but only *enabled* in two cases:
- Status is `awaiting_human` — label: "Take over"
- Driver hasn't heartbeated in >15s — label: "The other tab isn't responding — take over?"

In `running` (with fresh heartbeat), `complete`, and `error` states, the button is disabled with a tooltip.

**Rationale:** Take-over during active streaming would have to abort the in-flight argument and re-stream it, which costs tokens and may produce a different argument the second time. Not worth it.

### Q2. Driver crash mid-round

**Decision:** When the driver crashes (closes tab, network gone), the partial in-flight argument is lost (it was never persisted — it only existed in the driver's memory). The lease goes stale within 15s. Behavior depends on what tabs exist:

- **Another tab/device exists, viewing the same debate:** That tab sees the stale lease → "Take over" button activates → user clicks → claims lease → resumes from the last persisted argument. The lost in-flight argument is re-run (token cost = one model call).
- **No other tab exists:** Same as current behavior — debate is paused on the next page load. The user reopens the debate, sees a "Continue Debate" button (existing UI), clicks it, claims the lease, resumes from the last persisted argument.

The two cases are the same flow under the hood: claim lease, read DB state, resume. The only difference is the trigger (Take over button vs Continue Debate button).

### Q3. Realtime echo merge strategy

**Decision:** STRICT — local state is authoritative for the current debate, with one special case:

- For *completed* arguments (`(round, debater_index)` already in local state): keep local. Realtime echoes are dropped silently.
- For *new* arguments (not yet in local state): accept from Realtime. This is how follower tabs get updates.
- For the *currently streaming* argument (the one being filled token-by-token in the driver tab): local always wins. A Realtime echo of the previous complete argument must NEVER clobber the in-progress streaming buffer.
- For status fields (`status`, `current_round`, etc.): always accept from Realtime — these change less often and the DB is the cross-tab truth for them.

---

## Schema changes

Add to the `debates` table:

```sql
ALTER TABLE debates
  ADD COLUMN status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'awaiting_human', 'complete', 'error')),
  ADD COLUMN current_round int NOT NULL DEFAULT 0,
  ADD COLUMN awaiting_debater_index int,
  ADD COLUMN driver_session_id text,
  ADD COLUMN driver_heartbeat_at timestamptz,
  ADD COLUMN last_error text;

-- Backfill: existing complete debates → 'complete', incomplete → 'idle'
UPDATE debates SET status = CASE
  WHEN is_complete THEN 'complete'
  ELSE 'idle'
END;
```

**Realtime:** Enable Realtime on the `debates` table via Supabase dashboard → Database → Replication → toggle `debates`.

**Note on `is_complete`:** Keep the existing `is_complete` column for backwards compatibility with the share view and explore feed queries. The new `status` field is the source of truth for the orchestrator; `is_complete` is set to `true` whenever `status` becomes `'complete'`.

**RLS:** No new policies needed. Existing read/write policies on `debates` cover follower-read and driver-write.

### New RPC: `claim_debate_lease`

```sql
CREATE OR REPLACE FUNCTION claim_debate_lease(
  p_debate_id uuid,
  p_session_id text,
  p_force_if_stale_secs int DEFAULT 15
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row debates%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM debates WHERE id = p_debate_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  -- Already the driver
  IF v_row.driver_session_id = p_session_id THEN
    UPDATE debates
      SET driver_heartbeat_at = now()
      WHERE id = p_debate_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'already_owner');
  END IF;

  -- No driver
  IF v_row.driver_session_id IS NULL THEN
    UPDATE debates
      SET driver_session_id = p_session_id,
          driver_heartbeat_at = now()
      WHERE id = p_debate_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'no_prior_driver');
  END IF;

  -- Stale driver
  IF v_row.driver_heartbeat_at IS NULL
     OR (now() - v_row.driver_heartbeat_at) > make_interval(secs => p_force_if_stale_secs) THEN
    UPDATE debates
      SET driver_session_id = p_session_id,
          driver_heartbeat_at = now()
      WHERE id = p_debate_id;
    RETURN jsonb_build_object('claimed', true, 'reason', 'stale_lease');
  END IF;

  -- Active driver, not us
  RETURN jsonb_build_object(
    'claimed', false,
    'reason', 'active_driver',
    'current_driver', v_row.driver_session_id,
    'heartbeat_age_secs', extract(epoch from (now() - v_row.driver_heartbeat_at))
  );
END;
$$;
```

### New RPC: `release_debate_lease`

Called by the driver on natural completion / explicit abandonment. Just clears `driver_session_id` if the caller is the current driver. Idempotent.

### New RPC: `heartbeat_debate_lease`

Called by the driver every 5s. Updates `driver_heartbeat_at = now()` only if the caller is the current driver. Cheap. Returns the row for cheap reconciliation.

---

## Server-side changes (`app/api/debate/route.ts`)

Two changes:

### 1. Persist arguments per-argument

Currently the client calls `updateDebateArguments` after `round_complete`. Move this server-side. Inside the streaming `start(controller)` block, immediately after enqueuing the `argument` SSE event, call a Supabase update on the `debates` row to append the argument to the `arguments` jsonb array. This way:

- Followers see new arguments via Realtime within ~300ms of the driver finishing them
- If the driver crashes mid-round, the just-finished argument is already persisted
- The client `lib/debates.ts updateDebateArguments` calls become redundant (but keep the function for the human-turn case where the client builds the argument)

### 2. Update status flags as the loop progresses

- On entry: `status='running', current_round=N`
- On `user_turn_needed`: `status='awaiting_human', awaiting_debater_index=N`
- On `round_complete` for the final round: `status='complete', is_complete=true`
- On error: `status='error', last_error='...'`

Status updates can be batched into the same UPDATE statements as the argument writes when possible.

---

## Frontend: lift orchestrator into a provider

### New file: `lib/orchestrator/DebateOrchestratorProvider.tsx`

Mounted in `app/layout.tsx` so it survives all in-app navigation.

### Two hooks (re-render scope split)

```ts
useDebateStatus()
// Slow-changing fields. Subscribed by the sidebar, header, route guards.
{
  activeDebateId: string | null;
  status: 'idle' | 'running' | 'awaiting_human' | 'complete' | 'error';
  isDriver: boolean;
  awaitingHumanForMe: boolean;  // true if status === 'awaiting_human' AND we are the driver
  currentRound: number;
  totalRounds: number;
  error: string | null;
}

useDebateStream()
// Fast-changing fields. Subscribed only by the arena page's argument list.
{
  liveArguments: LiveArgument[];
  currentThinking: { debaterIndex: number; modelName: string } | null;
  pendingUserTurn: PendingUserTurn | null;
}
```

The split exists because per-token updates would otherwise re-render the sidebar 30 times per second. Sidebar reads only `useDebateStatus` and stays cheap.

### Provider responsibilities

- Owns all orchestrator state (the things in `useState` in the existing page that relate to the running debate)
- Owns the orchestrator functions: `runDebate`, `runOneRound`, `handleSSE`, `promptUserTurn`, `handleUserSubmit`, `endDebate`, `extendDebate`
- Owns the lease lifecycle: claims on `runDebate` start, heartbeats every 5s while running, releases on completion/abandonment
- Owns the Realtime subscription: subscribes when `activeDebateId` is set, dispatches updates into local state via the strict-merge rules from Q3
- Owns the take-over flow
- Single-debate-per-tab guard: `runDebate` is a no-op (with a clear error) if `status === 'running'` already

### Orchestrator state machine

```
                       ┌──────────┐
                       │  idle    │  ◄── unmounted / no active debate
                       └────┬─────┘
                            │ runDebate(config)
                            │ → claim lease
                            │ → POST first round
                            ▼
                       ┌──────────┐
            ┌─────────►│ running  │  ◄── streaming tokens, lease heartbeating
            │          └────┬─────┘
            │               │
            │  user_turn_needed event from server
            │               ▼
            │          ┌──────────────┐
            │          │ awaiting_    │
            │          │ human        │  ◄── lease still held, no fetch open
            │          └────┬─────────┘
            │               │
            │  user submits OR loses lease via take-over
            │               ▼
            │          ┌──────────┐
            │          │ running  │ (resume)
            │          └────┬─────┘
            │               │
            │   round_complete with currentRound < totalRounds
            └───────────────┘
                            │
                            │ round_complete with currentRound === totalRounds
                            │ OR endRequested
                            ▼
                       ┌──────────┐
                       │ complete │ → release lease
                       └──────────┘
```

### Lease abandonment cases

- Natural completion: release explicitly
- User clicks "End debate": release explicitly
- Provider unmounts (only happens on full app teardown — page refresh, tab close): no release, lease goes stale within 15s
- Network drops: heartbeats fail silently, lease goes stale within 15s
- Take-over: the new driver claims, the old driver receives a Realtime update, sees `driver_session_id !== mySessionId`, tears down its orchestrator state

---

## Realtime subscription model

```ts
// Inside provider
useEffect(() => {
  if (!activeDebateId) return;

  const channel = supabase
    .channel(`debate-${activeDebateId}`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'debates',
      filter: `id=eq.${activeDebateId}`,
    }, (payload) => {
      reconcileRealtimeUpdate(payload.new as DebateRow);
    })
    .subscribe();

  return () => { channel.unsubscribe(); };
}, [activeDebateId]);
```

### `reconcileRealtimeUpdate` (the strict merge from Q3)

```
const incoming = payload;
const local = localState;

// 1. Status fields — DB always wins
setStatus(incoming.status);
setCurrentRound(incoming.current_round);
// ...

// 2. Driver change detection
if (incoming.driver_session_id !== mySessionId && local.isDriver) {
  // We just lost the lease
  abortInFlightFetch();
  clearPendingUserTurn();
  setIsDriver(false);
  // (Don't clear arguments — we still want to show the debate as a follower)
}
if (incoming.driver_session_id === mySessionId && !local.isDriver) {
  // We just became the driver (via successful take-over claim)
  setIsDriver(true);
  // The take-over caller is responsible for kicking off runDebate
}

// 3. Arguments merge — strict
const incomingArgs = incoming.arguments as DebateArgument[];
const merged = strictMergeArguments(local.liveArguments, incomingArgs);
if (merged !== local.liveArguments) setLiveArguments(merged);

function strictMergeArguments(local, incoming) {
  // Build a map of local args by (round, debater_index)
  const localKeys = new Set(local.filter(a => !a.streaming).map(a => `${a.round}-${a.debater_index}`));
  // Streaming arg in local always wins — never overwritten
  const streamingArg = local.find(a => a.streaming);

  // Start from local (preserves the streaming arg)
  const result = [...local];

  // Add any incoming arg whose (round, debater_index) is not already locally completed
  // and not currently being streamed
  for (const arg of incoming) {
    const key = `${arg.round}-${arg.debater_index}`;
    if (localKeys.has(key)) continue;  // already have a complete local copy
    if (streamingArg && streamingArg.round === arg.round && streamingArg.debater_index === arg.debater_index) continue;
    result.push({ ...arg, streaming: false });
  }
  return result;
}
```

---

## Take-over flow

### Triggering

Non-driver tab clicks "Take over" (or "Resume" — same flow, different label):

1. Provider in tab B calls `claim_debate_lease(debateId, mySessionId, force_if_stale_secs)`
   - For a `awaiting_human` claim: pass `force_if_stale_secs=0` (explicit takeover, no waiting)
   - For a stale-lease claim: pass `force_if_stale_secs=15` (only succeeds if actually stale)
2. Server RPC does conditional UPDATE inside a transaction. Returns success/failure.
3. On success: Realtime broadcasts the row update.

### Tab A (former driver) receives update

```
- Sees driver_session_id !== mySessionId
- Aborts in-flight fetch (if any) via AbortController.abort()
- Clears pendingUserTurn and resolver ref (the resolver Promise becomes orphaned, GCed)
- Sets isDriver=false
- UI re-renders: input box / generate button hidden, "Take over" button shown,
  arguments still visible (via existing local state + future Realtime updates)
```

### Tab B (new driver) receives same update

```
- Sees driver_session_id === mySessionId
- Sets isDriver=true
- Reads incoming.status:
    - 'awaiting_human': sets pendingUserTurn from incoming.awaiting_debater_index
      and the corresponding debater config from local state. UI renders input box.
    - 'running' (came from stale lease): kicks off runDebate from the persisted
      arguments. The orchestrator picks up at the last incomplete argument.
- Begins heartbeating
```

### What "kicks off runDebate from persisted arguments" means

The provider already has the debate config in local state (loaded when the user opened the debate). It calls a new variant of `runDebate` — `resumeDebate(debateId)` — which:

1. Loads the latest debate row from the DB (full source of truth)
2. Determines `currentRound` and `existingArguments` from the row
3. Calls `runOneRound` for the current round, which the API handles via the existing `existingArguments` parameter (the API already knows how to skip already-arguued slots within a round)

No new server-side logic needed for resume — the existing per-round API already handles it.

---

## Implementation order — 6 commits

Each commit should leave the app in a working state. Stop and verify before moving on.

### Commit 1: Schema migration + Realtime enabled

- Write `site/supabase/migrations/NNN_realtime_orchestrator.sql` (or add to `supabase/schema.sql` if that's the project pattern — verify which)
- Add the new columns to `debates`
- Add the three RPCs (`claim_debate_lease`, `release_debate_lease`, `heartbeat_debate_lease`)
- Run the migration in the Supabase SQL editor
- Manually enable Realtime on the `debates` table in the dashboard
- Existing app should still work — nothing reads the new fields yet

### Commit 2: Server-side per-argument persistence + status updates

- Modify `app/api/debate/route.ts` to write each argument to the DB inside the streaming loop
- Update `status` / `current_round` / `awaiting_debater_index` / `last_error` as the loop progresses
- Frontend `lib/debates.ts updateDebateArguments` is no longer called by the orchestrator (but the function stays for the human-turn case where the client builds the argument and persists it itself — actually with server persistence we may not need that either; verify during implementation)
- Manually verify: run a debate, watch the DB row update per argument, status flags transition correctly

### Commit 3: Lift orchestrator into provider, mount in layout

- Create `lib/orchestrator/DebateOrchestratorProvider.tsx`
- Move state and orchestrator functions from `app/arena/debate/page.tsx` into the provider
- Create the two hooks `useDebateStatus()` and `useDebateStream()`
- Mount the provider in `app/layout.tsx`
- The arena page becomes a thin consumer
- NO Realtime, NO lease yet — this commit is purely the context lift
- **Manually verify the in-app navigation fix:** Start a debate. Navigate to `/explore` while it's running. Navigate back. Debate should still be running and have advanced. Sidebar should be enabled throughout.
- This commit alone ships value — even if we stop here, the original complaint is fixed.

### Commit 4: Add lease claim + heartbeat in the provider

- `runDebate` calls `claim_debate_lease` before starting
- A 5s interval calls `heartbeat_debate_lease` while `status === 'running'`
- Natural completion calls `release_debate_lease`
- No follower mode yet — the provider still assumes it's always the driver
- **Manually verify:** Run a debate, observe lease writes in the DB, observe heartbeats firing. Open a second tab and try to start the same debate by ID — should fail (we don't render the take-over button yet, but the second tab should at least see the lease is taken).

### Commit 5: Realtime subscription + follower mode

- Add the Supabase Realtime subscription in the provider
- Implement `reconcileRealtimeUpdate` with the strict merge
- Add follower-mode rendering to the arena page (read-only, status text, no input box, no Generate button)
- **Manually verify:** Open the same debate in two tabs. Tab A starts driving. Tab B should be in follower mode, showing arguments as they arrive via Realtime (per-argument cadence, not per-token).

### Commit 6: Take-over UX

- Add the "Take over" button to follower mode with the enable/disable rules from Q1
- Wire up the lease-claim flow described above
- Implement tab-A teardown when it loses the lease
- Implement tab-B startup (resume from persisted state) when it gains the lease
- Add a "Continue Debate" path for the no-other-tab case (resume from page reload — same RPC, different entry point)
- **Manually verify all the cases:**
  - Two tabs, debate in `awaiting_human` in tab A, click Take over in tab B → input moves to tab B
  - Two tabs, kill tab A mid-stream → wait 15s → tab B sees stale lease → click Take over → tab B resumes
  - One tab, kill mid-stream → reload → click Continue Debate → resumes
  - Three tabs, all viewing the same debate → exactly one drives, two follow → take-over moves the input around correctly

---

## Recovery — if Claude crashes mid-refactor

This document is the source of truth for the plan. If a Claude session dies or context is lost, a new session can pick up by:

1. **Read this document fully.** All design decisions and the implementation order are here.
2. **Read `git log --oneline -20`** to see how far we've gotten. Each of the 6 commits above should have a recognizable subject line.
3. **Read `app/arena/debate/page.tsx`** — if the orchestrator is still inline, we're at or before commit 3. If it's been extracted, look for `lib/orchestrator/DebateOrchestratorProvider.tsx`.
4. **Read the `debates` table schema** in `site/supabase/schema.sql` — if the new columns exist, commit 1 is done.
5. **Check the API route** — if it has Supabase update calls inside the streaming loop, commit 2 is done.
6. **Check the layout file** — if the provider is mounted, commit 3 is done.
7. **Resume from the next uncompleted commit.**

### Things to verify before resuming

- Is the project still on the same branch? `git branch --show-current`
- Are there uncommitted changes from the previous session? `git status` — if so, decide whether to commit, stash, or discard before continuing
- Has the schema migration actually been *run* in Supabase, or just written? The SQL file existing on disk doesn't mean the DB has been updated
- Has Realtime been enabled in the Supabase dashboard? This is a manual click, not in SQL

---

## Open implementation questions (to resolve as we hit them)

1. **Migration format.** The project may not have a migration framework. Check `site/supabase/` for existing patterns. If there's only `schema.sql`, we may add new SQL there directly (less ideal, no versioning) or introduce a `migrations/` folder.

2. **`is_complete` vs `status`.** The `is_complete` boolean is read by the explore feed and the share view. Status is the new source of truth. Decision: keep both, set `is_complete=true` whenever `status='complete'`. Don't break existing reads.

3. **TypeScript types for the DB row.** `lib/types.ts` has `Debate`. Need to add the new fields. Check if there's a generated types file from Supabase first — if there is, regenerate. If not, hand-edit.

4. **Reconnect after temporary network drop.** Realtime should auto-reconnect via the Supabase JS client. The provider's strict merge handles the catch-up case automatically (reconciles whatever state changed while we were offline). Verify in commit 5.

5. **Multiple humans in the same debate.** Edge case but supported by the existing flow. Each human's turn pauses the orchestrator separately. Take-over needs to know *which* debater_index is awaiting input — already handled by `awaiting_debater_index` in the schema. Verify the UI shows the right human's identity.

6. **Provider unmount on full page navigation.** If the user navigates to a non-app URL or hard-refreshes, the provider unmounts and the lease is NOT explicitly released. It will go stale within 15s. This is fine — the same flow as a tab crash. Just don't be surprised by it.

7. **Reconnection token rate.** The 5s heartbeat means a worst-case ~5s detection window for "driver is OK." Combined with the 15s stale threshold, total max time before another tab can take over is ~20s. Tunable.

---

## What to test manually after each commit

| Commit | Test |
|---|---|
| 1 | DB query: `SELECT status, driver_session_id FROM debates LIMIT 1;` returns the new columns. Realtime tab shows `debates` enabled. |
| 2 | Run a debate. After each argument, refresh the share view in another browser — argument is there. Status flag transitions correctly through the round. |
| 3 | Run a debate. Navigate to /explore. Navigate back. Debate is still running and has new arguments. Sidebar is enabled the whole time. |
| 4 | Run a debate. Watch `driver_heartbeat_at` update every ~5s. After natural completion, `driver_session_id` is null. Kill the tab mid-stream and watch the heartbeat stop updating. |
| 5 | Open the same debate in two tabs. Start it from tab A. Tab B shows arguments arriving via Realtime (no token streaming, but per-argument bubbles). Status text in tab B reflects what tab A is doing. |
| 6 | All four take-over scenarios from the commit 6 verification list. Plus: cross-device test (one laptop, one phone) if possible. |

---

## Rollback plan

If anything goes wrong and we need to abandon partway:

- **After commit 1:** Drop the new columns and RPCs. No app behavior change.
- **After commit 2:** Revert the API route changes. The DB has extra columns but they're not read by anything. Harmless.
- **After commit 3:** Revert the provider extraction back to inline page state. This is the biggest mechanical revert — the only one that changes app behavior visibly.
- **After commit 4-6:** Revert the relevant commit and the app falls back to "lifted but not multi-tab synced." Each commit is independently revertable.

The 6-commit structure exists specifically so we can stop or roll back at any point and still have a coherent state.

---

## Notes from the discussion that led here

- Orchestrator is currently in `app/arena/debate/page.tsx` (~1555 lines as of pre-refactor commit). Extraction is also a chance to honor the "strip back and rebuild" memory rule.
- The user-turn Promise resolver pattern (`userTurnResolverRef`) is the trickiest thing to lift cleanly — needs to live on the provider.
- The arena page already handles `existingArguments` being passed back into the API for resumption, so the resume-from-DB-state flow doesn't need new server logic.
- Token deduction is atomic via RPC — no double-spend regardless of how many tabs are running.
- The 30 req/min IP rate limit gives loose abuse protection.
- The `temp instructions.txt` file is a personal scratchpad — left tracked because it was already tracked.
