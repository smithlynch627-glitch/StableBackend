-- =====================================================================================
-- STABLE: creators connect an X (Twitter) account before launching a collection.
-- Run once in Supabase: SQL Editor → paste → Run. Safe to run again (idempotent).
-- Only the X user id and @username are stored. X tokens are never stored.
-- =====================================================================================

alter table app.users add column if not exists x_user_id text;
alter table app.users add column if not exists x_username text check (x_username is null or x_username ~ '^[A-Za-z0-9_]{1,15}$');
alter table app.users add column if not exists x_connected_at timestamptz;

-- Pending "Connect X" attempts (10 minutes, used once).
create table if not exists app.x_oauth (
  state      text primary key check (char_length(state) between 20 and 100),
  address    text not null check (address ~ '^0x[0-9a-f]{40}$'),
  verifier   text not null,
  return_to  text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table app.x_oauth enable row level security;
drop policy if exists api_all on app.x_oauth;
create policy api_all on app.x_oauth for all to stable_api using (true) with check (true);
grant select, insert, update, delete on app.x_oauth to stable_api;
