-- =====================================================================================
-- STABLE: NFTs Launchpad & Marketplace — database schema (Supabase / Postgres 15+)
-- Run in Supabase: SQL Editor → paste → Run.  Safe to run again (idempotent).
--
-- Security model
--  • The website never talks to the database. Only the backend API does, over TLS.
--  • Data lives in private schemas (`app`, `chain_<id>`) that Supabase's public REST API
--    does not expose. RLS is enabled on every table and only the `stable_api` role has a policy,
--    so the `anon` / `authenticated` keys can read or write nothing, even if leaked.
--  • `stable_api` is a least-privilege login for the backend (no DDL, no superuser).
--    New chain schemas are created only through app.ensure_chain_schema() (SECURITY DEFINER).
--  • Sensitive fields (support contact details) are encrypted by the backend (AES-256-GCM)
--    before they reach the database.
-- =====================================================================================

create extension if not exists pgcrypto;

-- ── Roles ──────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'stable_api') then
    create role stable_api nologin noinherit;   -- 02_api_role.sql gives it a password and LOGIN
  end if;
end $$;

-- ── Global schema ──────────────────────────────────────────────────────────────────
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to stable_api;

-- Networks: the admin panel switches the whole marketplace by activating another row.
create table if not exists app.networks (
  key               text primary key check (key ~ '^[a-z0-9-]{3,40}$'),
  chain_id          integer not null unique check (chain_id > 0),
  name              text not null,
  rpc_url           text not null check (rpc_url ~ '^https?://'),       -- server RPC (can be private)
  public_rpc_url    text check (public_rpc_url ~ '^https?://'),         -- RPC the browser uses (https in production)
  explorer_url      text not null check (explorer_url ~ '^https?://'),
  explorer_api_url  text,                                               -- Blockscout API v2 base (for importing collections)
  is_testnet        boolean not null default true,
  market_address    text check (market_address ~ '^0x[0-9a-f]{40}$'),
  factory_address   text check (factory_address ~ '^0x[0-9a-f]{40}$'),
  fee_vault_address text check (fee_vault_address ~ '^0x[0-9a-f]{40}$'),
  weth_address      text not null default '0x4200000000000000000000000000000000000006' check (weth_address ~ '^0x[0-9a-f]{40}$'),
  official_collection text check (official_collection ~ '^0x[0-9a-f]{40}$'),
  start_block       bigint not null default 0 check (start_block >= 0),
  is_active         boolean not null default false,
  updated_by        text,
  updated_at        timestamptz not null default now()
);
create unique index if not exists networks_single_active on app.networks (is_active) where is_active;

create table if not exists app.admins (
  address    text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  role       text not null check (role in ('owner', 'admin', 'support')),
  added_by   text,
  created_at timestamptz not null default now()
);

create table if not exists app.users (
  address    text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  username   text check (username ~ '^[[:alnum:]_.-]{3,24}$'),
  bio        text not null default '' check (char_length(bio) <= 280),
  is_banned  boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists users_username_ci on app.users (lower(username)) where username is not null;

create table if not exists app.auth_nonces (
  address    text primary key,
  nonce      text not null,
  expires_at timestamptz not null
);

create table if not exists app.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique,
  address         text not null check (address ~ '^0x[0-9a-f]{40}$'),
  category        text not null check (category in ('general','mint','trade','listing','offer','collection','wallet','bug','report','other')),
  subject         text not null check (char_length(subject) between 3 and 140),
  contact_enc     text,                          -- AES-256-GCM ciphertext, never plaintext
  status          text not null default 'open' check (status in ('open','waiting','resolved','closed')),
  priority        text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  chain_id        integer,
  collection      text,
  token_id        text,
  tx_hash         text check (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  assigned_to     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists tickets_status_idx on app.support_tickets (status, last_message_at desc);
create index if not exists tickets_address_idx on app.support_tickets (address, created_at desc);

create table if not exists app.ticket_messages (
  id         bigserial primary key,
  ticket_id  uuid not null references app.support_tickets(id) on delete cascade,
  author     text not null,
  is_staff   boolean not null default false,
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists ticket_messages_idx on app.ticket_messages (ticket_id, id);

create table if not exists app.audit_log (
  id         bigserial primary key,
  actor      text not null,
  action     text not null,
  target     text,
  details    jsonb not null default '{}',
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists audit_time_idx on app.audit_log (created_at desc);

-- Small images hosted by the API when IPFS is not configured (e.g. a pre-reveal image).
create table if not exists app.media (
  id         uuid primary key default gen_random_uuid(),
  owner      text not null,
  mime       text not null check (mime in ('image/png','image/jpeg','image/gif','image/webp')),
  bytes      bytea not null,
  size       integer not null check (size between 1 and 2097152),
  sha256     text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists media_dedupe on app.media (owner, sha256);

-- Site settings editable in the admin panel (e.g. community links shown in the footer).
create table if not exists app.settings (
  key        text primary key check (key ~ '^[a-z0-9_.]{2,60}$'),
  value      jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Lock every app table: RLS on, only stable_api allowed.
do $$
declare t text;
begin
  foreach t in array array['networks','admins','users','auth_nonces','support_tickets','ticket_messages','audit_log','media','settings'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists api_all on app.%I', t);
    execute format('create policy api_all on app.%I for all to stable_api using (true) with check (true)', t);
  end loop;
end $$;
grant select, insert, update, delete on all tables in schema app to stable_api;
grant usage, select on all sequences in schema app to stable_api;
revoke delete on app.audit_log from stable_api;          -- audit log is append-only for the API

-- ── Per-chain data schema (one per network) ────────────────────────────────────────
create or replace function app.ensure_chain_schema(p_chain_id integer)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  s text := 'chain_' || p_chain_id::text;
  t text;
begin
  if p_chain_id is null or p_chain_id <= 0 then
    raise exception 'invalid chain id';
  end if;
  execute format('create schema if not exists %I', s);

  execute format($ddl$
    create table if not exists %1$I.collections (
      address          text primary key check (address ~ '^0x[0-9a-f]{40}$'),
      chain_id         integer not null default %2$s,
      slug             text unique not null,
      name             text not null,
      symbol           text,
      description      text not null default '',
      image_url        text,
      banner_url       text,
      art_style        text not null default 'tile',
      creator          text,
      royalty_bps      integer not null default 0,
      royalty_receiver text,
      max_supply       integer,
      total_supply     integer not null default 0,
      contract_uri     text,
      twitter          text,
      website          text,
      discord          text,
      telegram         text,
      verified         boolean not null default false,
      is_official      boolean not null default false,
      is_external      boolean not null default false,
      featured         boolean not null default false,
      hidden           boolean not null default false,
      tradable         boolean not null default true,
      revealed         boolean,
      metadata_frozen  boolean not null default false,
      mint_paused      boolean not null default false,
      drop_hidden      boolean not null default false,
      floor_wei        numeric(78,0),
      best_offer_wei   numeric(78,0),
      volume_wei       numeric(78,0) not null default 0,
      volume_24h_wei   numeric(78,0) not null default 0,
      sales_count      integer not null default 0,
      owners_count     integer not null default 0,
      listed_count     integer not null default 0,
      created_at       timestamptz not null default now()
    )$ddl$, s, p_chain_id);
  -- upgrades for schemas created by an earlier version
  execute format('alter table %I.collections add column if not exists discord text', s);
  execute format('alter table %I.collections add column if not exists telegram text', s);
  -- About tab (written by admins in the admin panel)
  execute format('alter table %I.collections add column if not exists about text', s);
  execute format('alter table %I.collections add column if not exists about_image_url text', s);
  execute format($a$alter table %I.collections add column if not exists about_items jsonb not null default '[]'$a$, s);
  execute format('alter table %I.collections add column if not exists drop_hidden boolean not null default false', s);
  execute format('create index if not exists collections_volume_idx on %I.collections (volume_24h_wei desc)', s);
  execute format('create index if not exists collections_created_idx on %I.collections (created_at desc)', s);

  execute format($ddl$
    create table if not exists %1$I.tokens (
      collection    text not null references %1$I.collections(address) on delete cascade,
      token_id      numeric(78,0) not null,
      owner         text,
      name          text,
      image_url     text,
      attributes    jsonb not null default '[]',
      rarity_rank   integer,
      last_sale_wei numeric(78,0),
      hidden        boolean not null default false,
      minted_at     timestamptz default now(),
      primary key (collection, token_id)
    )$ddl$, s);
  execute format('create index if not exists tokens_owner_idx on %I.tokens (owner)', s);
  execute format('create index if not exists tokens_attr_idx on %I.tokens using gin (attributes jsonb_path_ops)', s);

  execute format($ddl$
    create table if not exists %1$I.orders (
      hash       text primary key,
      chain_id   integer not null default %2$s,
      kind       text not null check (kind in ('listing','offer','collection_offer')),
      collection text not null references %1$I.collections(address) on delete cascade,
      token_id   numeric(78,0),
      maker      text not null,
      price_wei  numeric(78,0) not null check (price_wei > 0),
      currency   text not null default 'ETH',
      status     text not null default 'active' check (status in ('active','filled','cancelled','expired','inactive')),
      start_time timestamptz not null default now(),
      end_time   timestamptz not null,
      counter    numeric(78,0) not null default 0,
      order_json jsonb,
      tx_hash    text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )$ddl$, s, p_chain_id);
  execute format('create index if not exists orders_floor_idx on %I.orders (collection, kind, status, price_wei)', s);
  execute format('create index if not exists orders_token_idx on %I.orders (collection, token_id, kind, status)', s);
  execute format('create index if not exists orders_maker_idx on %I.orders (maker, status)', s);

  execute format($ddl$
    create table if not exists %1$I.activity (
      id         bigserial primary key,
      chain_id   integer not null default %2$s,
      type       text not null,
      collection text not null references %1$I.collections(address) on delete cascade,
      token_id   numeric(78,0),
      from_addr  text,
      to_addr    text,
      price_wei  numeric(78,0),
      tx_hash    text,
      order_hash text,
      log_index  integer,
      created_at timestamptz not null default now()
    )$ddl$, s, p_chain_id);
  execute format('create index if not exists activity_collection_idx on %I.activity (collection, created_at desc)', s);
  execute format('create index if not exists activity_token_idx on %I.activity (collection, token_id, created_at desc)', s);
  execute format('create index if not exists activity_from_idx on %I.activity (from_addr, created_at desc)', s);
  execute format('create index if not exists activity_to_idx on %I.activity (to_addr, created_at desc)', s);
  execute format('create index if not exists activity_time_idx on %I.activity (created_at desc)', s);
  execute format('create unique index if not exists activity_log_uniq on %I.activity (tx_hash, log_index, type) where tx_hash is not null and log_index is not null', s);

  execute format($ddl$
    create table if not exists %1$I.drops (
      collection       text primary key references %1$I.collections(address) on delete cascade,
      phases           jsonb not null default '[]',
      platform_fee_bps integer not null default 1000,
      featured         boolean not null default false,
      created_at       timestamptz not null default now()
    )$ddl$, s);

  execute format($ddl$
    create table if not exists %1$I.allowlists (
      id         uuid primary key default gen_random_uuid(),
      root       text not null,
      addresses  jsonb not null,
      tree       jsonb not null,
      created_by text,
      created_at timestamptz not null default now()
    )$ddl$, s);

  execute format($ddl$
    create table if not exists %1$I.fee_ledger (
      id         bigserial primary key,
      source     text not null check (source in ('mint','trade')),
      collection text,
      amount_wei numeric(78,0) not null,
      tx_hash    text,
      created_at timestamptz not null default now()
    )$ddl$, s);

  -- Fee ledger rows are keyed by log so re-indexing a block range never counts a fee twice.
  execute format('alter table %I.fee_ledger add column if not exists log_index integer', s);
  execute format('create unique index if not exists fee_ledger_log_uniq on %I.fee_ledger (tx_hash, log_index) where tx_hash is not null and log_index is not null', s);

  -- Mint configuration edits made after minting started (shown as an alert on the mint page).
  execute format($ddl$
    create table if not exists %1$I.phase_changes (
      id         bigserial primary key,
      collection text not null references %1$I.collections(address) on delete cascade,
      tx_hash    text,
      changes    jsonb not null,
      changed_at timestamptz not null default now()
    )$ddl$, s);
  execute format('create unique index if not exists phase_changes_tx on %I.phase_changes (collection, tx_hash) where tx_hash is not null', s);
  execute format('create index if not exists phase_changes_time on %I.phase_changes (collection, changed_at desc)', s);

  -- Hourly snapshots for analytics charts (floor history etc.).
  execute format($ddl$
    create table if not exists %1$I.snapshots (
      collection     text not null references %1$I.collections(address) on delete cascade,
      taken_at       timestamptz not null,
      floor_wei      numeric(78,0),
      best_offer_wei numeric(78,0),
      listed_count   integer not null default 0,
      owners_count   integer not null default 0,
      volume_wei     numeric(78,0) not null default 0,
      sales_count    integer not null default 0,
      primary key (collection, taken_at)
    )$ddl$, s);

  execute format('create table if not exists %I.indexer_state (key text primary key, value text not null)', s);

  -- Lock it down exactly like the app schema.
  execute format('revoke all on schema %I from public', s);
  execute format('grant usage on schema %I to stable_api', s);
  foreach t in array array['collections','tokens','orders','activity','drops','allowlists','fee_ledger','indexer_state','phase_changes','snapshots'] loop
    execute format('alter table %I.%I enable row level security', s, t);
    execute format('drop policy if exists api_all on %I.%I', s, t);
    execute format('create policy api_all on %I.%I for all to stable_api using (true) with check (true)', s, t);
  end loop;
  execute format('grant select, insert, update, delete on all tables in schema %I to stable_api', s);
  execute format('grant usage, select on all sequences in schema %I to stable_api', s);
  return s;
end
$fn$;
revoke all on function app.ensure_chain_schema(integer) from public;
grant execute on function app.ensure_chain_schema(integer) to stable_api;

-- Belt and braces for Supabase: the public API roles get nothing in our schemas.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema app from anon, authenticated';
    execute 'revoke all on all tables in schema app from anon, authenticated';
    execute 'revoke execute on function app.ensure_chain_schema(integer) from anon, authenticated';
  end if;
end $$;

-- ── Default network: GIWA Sepolia (contract addresses are filled in the admin panel or from env) ──
insert into app.networks (key, chain_id, name, rpc_url, public_rpc_url, explorer_url, explorer_api_url, is_testnet, is_active)
values ('giwa-sepolia', 91342, 'GIWA Sepolia', 'https://sepolia-rpc.giwa.io', 'https://sepolia-rpc.giwa.io',
        'https://sepolia-explorer.giwa.io', 'https://sepolia-explorer.giwa.io/api/v2', true,
        not exists (select 1 from app.networks where is_active))
on conflict (key) do nothing;

select app.ensure_chain_schema(91342);
