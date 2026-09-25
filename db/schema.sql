-- GIWA Launchpad & Marketplace schema (PostgreSQL / Supabase)
-- Addresses are stored lowercase. Prices are wei in numeric(78,0).

create extension if not exists pgcrypto;

create table if not exists collections (
  address          text primary key,
  chain_id         int not null default 91342,
  slug             text unique not null,
  name             text not null,
  symbol           text,
  description      text default '',
  image_url        text,
  banner_url       text,
  art_style        text not null default 'tile',       -- placeholder art style: 'cow' | 'tile'
  creator          text,
  royalty_bps      int not null default 0,
  royalty_receiver text,
  max_supply       int,
  total_supply     int not null default 0,
  verified         boolean not null default false,
  is_official      boolean not null default false,
  is_demo          boolean not null default false,
  twitter          text,
  website          text,
  floor_wei        numeric(78,0),
  best_offer_wei   numeric(78,0),
  volume_wei       numeric(78,0) not null default 0,
  volume_24h_wei   numeric(78,0) not null default 0,
  sales_count      int not null default 0,
  owners_count     int not null default 0,
  listed_count     int not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists collections_volume_idx on collections (volume_24h_wei desc);
create index if not exists collections_created_idx on collections (created_at desc);

create table if not exists tokens (
  collection     text not null references collections(address) on delete cascade,
  token_id       numeric(78,0) not null,
  owner          text,
  name           text,
  image_url      text,
  attributes     jsonb not null default '[]',
  rarity_rank    int,
  last_sale_wei  numeric(78,0),
  minted_at      timestamptz default now(),
  primary key (collection, token_id)
);
create index if not exists tokens_owner_idx on tokens (owner);
create index if not exists tokens_attr_idx on tokens using gin (attributes jsonb_path_ops);

create table if not exists orders (
  hash        text primary key,
  chain_id    int not null default 91342,
  kind        text not null check (kind in ('listing','offer','collection_offer')),
  collection  text not null references collections(address) on delete cascade,
  token_id    numeric(78,0),
  maker       text not null,
  price_wei   numeric(78,0) not null,
  currency    text not null default 'ETH',
  status      text not null default 'active'
              check (status in ('active','filled','cancelled','expired','inactive','pending_cancel')),
  start_time  timestamptz not null default now(),
  end_time    timestamptz not null,
  counter     numeric(78,0) not null default 0,
  order_json  jsonb,
  tx_hash     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists orders_floor_idx on orders (collection, kind, status, price_wei);
create index if not exists orders_token_idx on orders (collection, token_id, kind, status);
create index if not exists orders_maker_idx on orders (maker, status);

create table if not exists activity (
  id          bigserial primary key,
  chain_id    int not null default 91342,
  type        text not null,  -- mint | list | delist | sale | transfer | offer | offer_cancel | collection_offer
  collection  text not null references collections(address) on delete cascade,
  token_id    numeric(78,0),
  from_addr   text,
  to_addr     text,
  price_wei   numeric(78,0),
  tx_hash     text,
  order_hash  text,
  log_index   int,
  created_at  timestamptz not null default now()
);
create index if not exists activity_collection_idx on activity (collection, created_at desc);
create index if not exists activity_token_idx on activity (collection, token_id, created_at desc);
create index if not exists activity_from_idx on activity (from_addr, created_at desc);
create index if not exists activity_to_idx on activity (to_addr, created_at desc);
create index if not exists activity_time_idx on activity (created_at desc);
create unique index if not exists activity_log_uniq on activity (tx_hash, log_index, type)
  where tx_hash is not null and log_index is not null;

create table if not exists drops (
  collection       text primary key references collections(address) on delete cascade,
  phases           jsonb not null default '[]',  -- [{name,start,end,priceWei,maxPerWallet,allowlistId}]
  platform_fee_bps int not null default 1000,
  featured         boolean not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists allowlists (
  id          uuid primary key default gen_random_uuid(),
  root        text not null,
  addresses   jsonb not null,
  tree        jsonb not null,
  created_by  text,
  created_at  timestamptz not null default now()
);

create table if not exists users (
  address     text primary key,
  username    text unique,
  bio         text default '',
  created_at  timestamptz not null default now()
);

create table if not exists auth_nonces (
  address     text primary key,
  nonce       text not null,
  expires_at  timestamptz not null
);

create table if not exists fee_ledger (
  id          bigserial primary key,
  source      text not null check (source in ('mint','trade')),
  collection  text,
  amount_wei  numeric(78,0) not null,
  tx_hash     text,
  created_at  timestamptz not null default now()
);

create table if not exists indexer_state (
  key    text primary key,
  value  text not null
);
