-- ============================================================================
-- gladaitor Public Site — Database Schema
-- ============================================================================
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- Safe to re-run — uses IF NOT EXISTS and DROP IF EXISTS throughout.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Token economy constants
-- ----------------------------------------------------------------------------
-- Single source of truth for starting token balances. Changing these values
-- automatically updates the column DEFAULTs (because the DEFAULTs reference
-- these functions) AND every RPC that creates a new session row, so we
-- don't have to chase magic numbers across the file. To change the
-- balances, edit the `select N` literal in each function below and re-run
-- this schema.
--
-- IMPORTANT: column DEFAULTs only apply to NEW rows. Existing profiles or
-- sessions are not retroactively topped up when these values change.
-- ----------------------------------------------------------------------------

create or replace function public.signup_starting_tokens()
returns int as $$ select 50 $$ language sql immutable;

create or replace function public.anonymous_starting_tokens()
returns int as $$ select 15 $$ language sql immutable;

-- Re-apply column DEFAULTs to existing tables. `create table if not exists`
-- below is a no-op on existing tables, so without these explicit ALTERs the
-- old literal DEFAULTs (e.g. default 20, default 6) would remain in place.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles') then
    execute 'alter table public.profiles alter column token_balance set default public.signup_starting_tokens()';
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'sessions') then
    execute 'alter table public.sessions alter column token_balance set default public.anonymous_starting_tokens()';
  end if;
end$$;

-- User profiles (extends Supabase auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  display_name text,
  token_balance int not null default public.signup_starting_tokens(),
  created_at timestamptz not null default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, token_balance)
  values (new.id, new.email, public.signup_starting_tokens());
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Debates
create table if not exists public.debates (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid references public.profiles(id) on delete set null,
  creator_session_id text,
  topic text not null,
  positions jsonb not null,
  models text[] not null,
  rounds int not null,
  context text,
  arguments jsonb not null default '[]'::jsonb,
  is_complete boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_viewed_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_debates_expires on public.debates(expires_at)
  where expires_at is not null;
create index if not exists idx_debates_user on public.debates(creator_user_id)
  where creator_user_id is not null;
create index if not exists idx_debates_session on public.debates(creator_session_id)
  where creator_session_id is not null and creator_user_id is null;

-- Row Level Security
alter table public.profiles enable row level security;
alter table public.debates enable row level security;

-- Drop all existing policies to rebuild cleanly
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Anyone can view debates" on public.debates;
drop policy if exists "Authenticated users can create debates" on public.debates;
drop policy if exists "Anon can create debates" on public.debates;
drop policy if exists "Anyone can create debates" on public.debates;
drop policy if exists "Creators can update own debates" on public.debates;
drop policy if exists "Creators can delete own debates" on public.debates;

-- Profiles policies
create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Debates policies
create policy "Anyone can view debates"
  on public.debates for select using (true);

create policy "Anyone can create debates"
  on public.debates for insert with check (true);

create policy "Creators can update own debates"
  on public.debates for update using (
    auth.uid() = creator_user_id
    or (creator_user_id is null)
  );

create policy "Creators can delete own debates"
  on public.debates for delete using (
    auth.uid() = creator_user_id
    or (creator_user_id is null)
  );

-- Anonymous sessions (token tracking for logged-out users)
create table if not exists public.sessions (
  id text primary key,
  token_balance int not null default public.anonymous_starting_tokens(),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

drop policy if exists "Sessions are server-managed" on public.sessions;
create policy "Sessions are server-managed"
  on public.sessions for all using (true);

-- Deduct N tokens from a user's balance atomically (all or nothing)
create or replace function public.deduct_user_tokens(p_user_id uuid, p_amount int)
returns boolean as $$
declare
  new_balance int;
begin
  if p_amount <= 0 then return true; end if;

  update public.profiles
  set token_balance = token_balance - p_amount
  where id = p_user_id and token_balance >= p_amount
  returning token_balance into new_balance;

  return found;
end;
$$ language plpgsql security definer;

-- Deduct N tokens from a session's balance atomically (all or nothing)
create or replace function public.deduct_session_tokens(p_session_id text, p_amount int)
returns boolean as $$
declare
  new_balance int;
begin
  if p_amount <= 0 then return true; end if;

  -- Upsert the session (create with default balance if it doesn't exist)
  insert into public.sessions (id, token_balance, last_used_at)
  values (p_session_id, public.anonymous_starting_tokens(), now())
  on conflict (id) do update set last_used_at = now();

  -- Now deduct atomically
  update public.sessions
  set token_balance = token_balance - p_amount
  where id = p_session_id and token_balance >= p_amount
  returning token_balance into new_balance;

  return found;
end;
$$ language plpgsql security definer;

-- Get token balance for a user or session
create or replace function public.get_token_balance(
  p_user_id uuid default null,
  p_session_id text default null
)
returns int as $$
declare
  balance int;
begin
  if p_user_id is not null then
    select token_balance into balance from public.profiles where id = p_user_id;
    return coalesce(balance, 0);
  end if;

  if p_session_id is not null then
    -- Upsert session to ensure it exists
    insert into public.sessions (id, token_balance)
    values (p_session_id, public.anonymous_starting_tokens())
    on conflict (id) do nothing;

    select token_balance into balance from public.sessions where id = p_session_id;
    return coalesce(balance, 0);
  end if;

  return 0;
end;
$$ language plpgsql security definer;

-- Transfer remaining session tokens to user on signup/login
create or replace function public.absorb_session_tokens(
  p_user_id uuid,
  p_session_id text
)
returns int as $$
declare
  session_tokens int;
begin
  -- Get and delete session tokens
  delete from public.sessions
  where id = p_session_id
  returning token_balance into session_tokens;

  if session_tokens is not null and session_tokens > 0 then
    update public.profiles
    set token_balance = token_balance + session_tokens
    where id = p_user_id;
  end if;

  return coalesce(session_tokens, 0);
end;
$$ language plpgsql security definer;

-- Credit tokens to a user (for Stripe purchases)
create or replace function public.credit_user_tokens(
  p_user_id uuid,
  p_amount int
)
returns int as $$
declare
  new_balance int;
begin
  update public.profiles
  set token_balance = token_balance + p_amount
  where id = p_user_id
  returning token_balance into new_balance;

  return coalesce(new_balance, 0);
end;
$$ language plpgsql security definer;

-- Credit tokens back to a session balance (used for refunds — see refundTokens
-- in app/api/debate/route.ts when a model is pre-deducted then refuses to engage).
-- Returns the new balance, or 0 if the session row doesn't exist.
create or replace function public.credit_session_tokens(
  p_session_id text,
  p_amount int
)
returns int as $$
declare
  new_balance int;
begin
  if p_amount <= 0 then
    select token_balance into new_balance from public.sessions where id = p_session_id;
    return coalesce(new_balance, 0);
  end if;

  update public.sessions
  set token_balance = token_balance + p_amount,
      last_used_at = now()
  where id = p_session_id
  returning token_balance into new_balance;

  return coalesce(new_balance, 0);
end;
$$ language plpgsql security definer;

-- Coupons
create table if not exists public.coupons (
  code text primary key,
  token_amount int not null,
  max_uses int,                    -- null = unlimited
  times_used int not null default 0,
  expires_at timestamptz,          -- null = never expires
  created_at timestamptz not null default now()
);

create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_code text not null references public.coupons(code),
  user_id uuid not null references public.profiles(id),
  redeemed_at timestamptz not null default now(),
  unique(coupon_code, user_id)     -- one redemption per user per code
);

alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;

drop policy if exists "Coupons are server-managed" on public.coupons;
create policy "Coupons are server-managed"
  on public.coupons for all using (true);

drop policy if exists "Redemptions are server-managed" on public.coupon_redemptions;
create policy "Redemptions are server-managed"
  on public.coupon_redemptions for all using (true);

-- Redeem a coupon — returns token amount on success, 0 on failure
create or replace function public.redeem_coupon(
  p_user_id uuid,
  p_code text
)
returns int as $$
declare
  v_coupon record;
  v_already_used boolean;
begin
  -- Look up coupon
  select * into v_coupon from public.coupons where code = upper(trim(p_code));
  if not found then return 0; end if;

  -- Check expiry
  if v_coupon.expires_at is not null and v_coupon.expires_at < now() then return 0; end if;

  -- Check max uses
  if v_coupon.max_uses is not null and v_coupon.times_used >= v_coupon.max_uses then return 0; end if;

  -- Check if user already redeemed
  select exists(
    select 1 from public.coupon_redemptions
    where coupon_code = v_coupon.code and user_id = p_user_id
  ) into v_already_used;
  if v_already_used then return 0; end if;

  -- Redeem: credit tokens, record redemption, increment usage
  update public.profiles
  set token_balance = token_balance + v_coupon.token_amount
  where id = p_user_id;

  insert into public.coupon_redemptions (coupon_code, user_id)
  values (v_coupon.code, p_user_id);

  update public.coupons
  set times_used = times_used + 1
  where code = v_coupon.code;

  return v_coupon.token_amount;
end;
$$ language plpgsql security definer;

-- ============================================================================
-- Voting (cross-content: debates now, games later)
-- ============================================================================

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null,
  content_type text not null,        -- 'debate' for now, 'game' later
  voter_user_id uuid references public.profiles(id) on delete cascade,
  voter_session_id text,
  voted_for text not null,           -- the debater_index as text
  voted_at timestamptz not null default now()
);

-- One vote per viewer per content
create unique index if not exists votes_unique_user
  on public.votes(content_id, content_type, voter_user_id)
  where voter_user_id is not null;
create unique index if not exists votes_unique_session
  on public.votes(content_id, content_type, voter_session_id)
  where voter_user_id is null and voter_session_id is not null;

-- Index for fast aggregation
create index if not exists votes_by_content
  on public.votes(content_id, content_type);

alter table public.votes enable row level security;

drop policy if exists "Anyone can read votes" on public.votes;
create policy "Anyone can read votes"
  on public.votes for select using (true);

drop policy if exists "Anyone can cast votes" on public.votes;
create policy "Anyone can cast votes"
  on public.votes for insert with check (true);

-- Atomic cast — returns true on success, false if already voted
create or replace function public.cast_vote(
  p_content_id uuid,
  p_content_type text,
  p_user_id uuid,
  p_session_id text,
  p_voted_for text
) returns boolean as $$
declare
  v_inserted boolean;
  v_creator uuid;
  v_topic text;
begin
  insert into public.votes (content_id, content_type, voter_user_id, voter_session_id, voted_for)
  values (p_content_id, p_content_type, p_user_id, p_session_id, p_voted_for)
  on conflict do nothing;
  v_inserted := found;

  -- Notify the debate creator (unless they voted on their own debate).
  -- Anonymous debates don't get notifications because there's no creator account.
  if v_inserted and p_content_type = 'debate' then
    select creator_user_id, topic into v_creator, v_topic
    from public.debates where id = p_content_id;

    if v_creator is not null and v_creator is distinct from p_user_id then
      insert into public.notifications (user_id, type, content_id, content_type, data)
      values (
        v_creator,
        'vote_received',
        p_content_id,
        'debate',
        jsonb_build_object('topic', v_topic, 'voted_for', p_voted_for)
      );
    end if;
  end if;

  return v_inserted;
end;
$$ language plpgsql security definer;

-- ============================================================================
-- Notifications (in-app only for now; email digest is a separate later feature)
-- ============================================================================

-- Add a view counter to debates so milestone notifications can fire
alter table public.debates add column if not exists view_count int not null default 0;

-- Public feed opt-in. Default false: debates are only accessible by direct link
-- unless the creator explicitly opts in to listing them in the public feed.
alter table public.debates add column if not exists is_public boolean not null default false;
create index if not exists debates_public
  on public.debates(is_public, created_at desc)
  where is_public = true;

-- Per-debater "the model picked its own stance" flag, aligned to the models
-- array by index. NULL on legacy rows where this metadata wasn't recorded.
-- Surfaced on the shared debate view as a small "self-chosen" marker.
alter table public.debates
  add column if not exists auto_assigned boolean[];

-- Whether the debate was generated with revealIdentities=true (models knew
-- their opponents) or false (anonymous mode). NULL on legacy rows. Surfaced
-- on the shared debate view as a banner when explicitly false, because
-- "models had no idea who they were arguing with" is a compelling angle.
alter table public.debates
  add column if not exists reveal_identities boolean;

-- Response length preference: 'concise' (2-3 sentences, punchy) or
-- 'detailed' (150-250 words, substantive). NULL treated as 'detailed'
-- (the original default). Modifies the system prompt's body-format rules.
alter table public.debates
  add column if not exists response_length text;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,                      -- 'vote_received' | 'view_milestone'
  content_id uuid,                         -- the debate id (or future content id)
  content_type text,                       -- 'debate' for now
  data jsonb,                              -- type-specific payload (vote count, view count, etc.)
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_unread
  on public.notifications(user_id, read)
  where read = false;
create index if not exists notifications_recent
  on public.notifications(user_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "Users can read own notifications" on public.notifications;
create policy "Users can read own notifications"
  on public.notifications for select
  using (auth.uid() = user_id);

drop policy if exists "Users can update own notifications" on public.notifications;
create policy "Users can update own notifications"
  on public.notifications for update
  using (auth.uid() = user_id);

drop policy if exists "Notifications are server-inserted" on public.notifications;
create policy "Notifications are server-inserted"
  on public.notifications for insert
  with check (true);

-- Function to extend TTL on view + increment view count + fire milestone notifications
create or replace function public.extend_debate_ttl(debate_id uuid)
returns void as $$
declare
  v_creator uuid;
  v_topic text;
  v_new_count int;
begin
  update public.debates
  set
    last_viewed_at = now(),
    view_count = view_count + 1,
    expires_at = case
      when expires_at is not null then now() + interval '30 days'
      else null
    end
  where id = debate_id
  returning creator_user_id, topic, view_count into v_creator, v_topic, v_new_count;

  -- Insert a milestone notification when the view count crosses 10/50/100/500.
  -- Only when the debate has a registered creator (anonymous debates don't get
  -- notifications because there's no one to notify).
  if v_creator is not null and v_new_count in (10, 50, 100, 500) then
    insert into public.notifications (user_id, type, content_id, content_type, data)
    values (
      v_creator,
      'view_milestone',
      debate_id,
      'debate',
      jsonb_build_object('view_count', v_new_count, 'topic', v_topic)
    );
  end if;
end;
$$ language plpgsql security definer;


-- Function to link anonymous debates to user on signup (also absorbs session tokens)
create or replace function public.link_debates_to_user(
  p_user_id uuid,
  p_session_id text
)
returns int as $$
declare
  linked_count int;
begin
  -- Link debates
  update public.debates
  set
    creator_user_id = p_user_id,
    expires_at = null
  where creator_session_id = p_session_id
    and creator_user_id is null;

  get diagnostics linked_count = row_count;

  -- Absorb any remaining session tokens
  perform public.absorb_session_tokens(p_user_id, p_session_id);

  return linked_count;
end;
$$ language plpgsql security definer;

-- ============================================================================
-- Realtime Orchestrator (cross-tab live debate sync)
-- ============================================================================
-- Adds status + lease columns to debates so the orchestrator state lives in
-- the DB and can be observed by all tabs viewing the same debate via
-- Supabase Realtime. The lease ensures exactly one tab "drives" a given
-- debate at a time; other tabs are read-only followers until they explicitly
-- take over.
--
-- After running this section, manually enable Realtime replication on the
-- `debates` table in the Supabase dashboard:
--   Database -> Replication -> source `supabase_realtime` -> add `debates`
-- ============================================================================

-- Status fields
alter table public.debates
  add column if not exists status text not null default 'idle';
-- Tighten the allowed values. Use a separate constraint so we can drop and
-- recreate it without rewriting the column definition.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'debates_status_check'
  ) then
    alter table public.debates
      add constraint debates_status_check
      check (status in ('idle', 'running', 'awaiting_human', 'complete', 'error'));
  end if;
end$$;

alter table public.debates
  add column if not exists current_round int not null default 0;

alter table public.debates
  add column if not exists awaiting_debater_index int;

alter table public.debates
  add column if not exists driver_session_id text;

alter table public.debates
  add column if not exists driver_heartbeat_at timestamptz;

alter table public.debates
  add column if not exists last_error text;

-- One-time backfill: existing complete debates -> 'complete', everything
-- else stays 'idle' (the new default). Idempotent because we only touch
-- rows that are still at the default.
update public.debates
set status = 'complete'
where is_complete = true and status = 'idle';

-- Index for the stale-lease query (rare but should be cheap when it runs)
create index if not exists debates_driver_heartbeat
  on public.debates(driver_heartbeat_at)
  where driver_session_id is not null;

-- ----------------------------------------------------------------------------
-- Lease RPCs
-- ----------------------------------------------------------------------------
-- The lease is per-session (not per-user) because anonymous tabs need it too.
-- These functions are SECURITY DEFINER and trust the caller-supplied session
-- id, matching the existing trust model used by deduct_session_tokens et al.
-- The API route is responsible for passing the correct session id.
-- ----------------------------------------------------------------------------

-- Claim the driver lease for a debate. Returns a jsonb verdict so the caller
-- can distinguish "claimed" from "rejected because someone else is driving".
--
-- Claims if any of:
--   1. The caller is already the driver (refresh heartbeat, return ok)
--   2. There is no driver
--   3. The current driver hasn't heartbeated in p_force_if_stale_secs seconds
--
-- Pass p_force_if_stale_secs = 0 for an explicit takeover during awaiting_human
-- (the user is overriding even a fresh lease). The orchestrator decides which
-- threshold to use based on UI state.
create or replace function public.claim_debate_lease(
  p_debate_id uuid,
  p_session_id text,
  p_force_if_stale_secs int default 15
) returns jsonb as $$
declare
  v_row public.debates%rowtype;
  v_age_secs numeric;
begin
  select * into v_row from public.debates where id = p_debate_id for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_found');
  end if;

  -- Already the driver: refresh heartbeat
  if v_row.driver_session_id = p_session_id then
    update public.debates
      set driver_heartbeat_at = now()
      where id = p_debate_id;
    return jsonb_build_object('claimed', true, 'reason', 'already_owner');
  end if;

  -- No driver
  if v_row.driver_session_id is null then
    update public.debates
      set driver_session_id = p_session_id,
          driver_heartbeat_at = now()
      where id = p_debate_id;
    return jsonb_build_object('claimed', true, 'reason', 'no_prior_driver');
  end if;

  -- Stale driver (or explicit takeover with p_force_if_stale_secs = 0)
  v_age_secs := extract(epoch from (now() - coalesce(v_row.driver_heartbeat_at, 'epoch'::timestamptz)));
  if v_row.driver_heartbeat_at is null or v_age_secs > p_force_if_stale_secs then
    update public.debates
      set driver_session_id = p_session_id,
          driver_heartbeat_at = now()
      where id = p_debate_id;
    return jsonb_build_object(
      'claimed', true,
      'reason', case when p_force_if_stale_secs = 0 then 'forced_takeover' else 'stale_lease' end,
      'previous_driver', v_row.driver_session_id,
      'previous_age_secs', v_age_secs
    );
  end if;

  -- Active driver, not us, not stale
  return jsonb_build_object(
    'claimed', false,
    'reason', 'active_driver',
    'current_driver', v_row.driver_session_id,
    'heartbeat_age_secs', v_age_secs
  );
end;
$$ language plpgsql security definer;

-- Refresh the heartbeat. No-op if the caller is no longer the driver (which
-- means someone took over while we weren't looking — the caller should detect
-- this via the Realtime subscription and tear down its orchestrator).
-- Returns the current driver_session_id so the caller can confirm ownership.
create or replace function public.heartbeat_debate_lease(
  p_debate_id uuid,
  p_session_id text
) returns text as $$
declare
  v_current_driver text;
begin
  update public.debates
    set driver_heartbeat_at = now()
    where id = p_debate_id and driver_session_id = p_session_id
    returning driver_session_id into v_current_driver;

  if v_current_driver is null then
    -- Either the row doesn't exist or we're not the driver. Read the actual
    -- current driver so the caller can distinguish.
    select driver_session_id into v_current_driver
      from public.debates where id = p_debate_id;
  end if;

  return v_current_driver;
end;
$$ language plpgsql security definer;

-- Release the driver lease. Only releases if the caller is the current driver.
-- Idempotent — safe to call from cleanup paths even if the lease has already
-- been taken over.
create or replace function public.release_debate_lease(
  p_debate_id uuid,
  p_session_id text
) returns boolean as $$
declare
  v_released boolean;
begin
  update public.debates
    set driver_session_id = null,
        driver_heartbeat_at = null
    where id = p_debate_id and driver_session_id = p_session_id;
  v_released := found;
  return v_released;
end;
$$ language plpgsql security definer;