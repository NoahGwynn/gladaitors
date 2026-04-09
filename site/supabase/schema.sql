-- ============================================================================
-- GladAItors Public Site — Database Schema
-- ============================================================================
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- Safe to re-run — uses IF NOT EXISTS and DROP IF EXISTS throughout.
-- ============================================================================

-- User profiles (extends Supabase auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  display_name text,
  token_balance int not null default 20,
  created_at timestamptz not null default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, token_balance)
  values (new.id, new.email, 20);
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
  token_balance int not null default 6,
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
  values (p_session_id, 6, now())
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
    values (p_session_id, 6)
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