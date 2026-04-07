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

-- Function to extend TTL on view
create or replace function public.extend_debate_ttl(debate_id uuid)
returns void as $$
begin
  update public.debates
  set
    last_viewed_at = now(),
    expires_at = case
      when expires_at is not null then now() + interval '30 days'
      else null
    end
  where id = debate_id;
end;
$$ language plpgsql security definer;

-- Function to link anonymous debates to user on signup
create or replace function public.link_debates_to_user(
  p_user_id uuid,
  p_session_id text
)
returns int as $$
declare
  linked_count int;
begin
  update public.debates
  set
    creator_user_id = p_user_id,
    expires_at = null
  where creator_session_id = p_session_id
    and creator_user_id is null;

  get diagnostics linked_count = row_count;
  return linked_count;
end;
$$ language plpgsql security definer;