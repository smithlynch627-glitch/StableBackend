-- =====================================================================================
-- STABLE admin v2: multisig (Safe) proposals made in the admin panel + treasury history.
-- Run once in Supabase: SQL Editor → paste → Run. Safe to run again (idempotent).
-- (New installs get the same tables from 01_schema.sql.)
-- =====================================================================================

-- Safe transactions proposed in the admin panel. GIWA has no Safe web app, so owners sign here (EIP-712 SafeTx)
-- and any owner executes once enough have signed. The Safe re-checks every signature on-chain.
create table if not exists app.safe_proposals (
  id            bigserial primary key,
  chain_id      integer not null,
  safe          text not null check (safe ~ '^0x[0-9a-f]{40}$'),
  to_address    text not null check (to_address ~ '^0x[0-9a-f]{40}$'),
  value_wei     numeric(78,0) not null default 0 check (value_wei >= 0),
  data          text not null check (data ~ '^0x([0-9a-f]{2})*$' and char_length(data) <= 20000),
  nonce         bigint not null check (nonce >= 0),
  safe_tx_hash  text not null check (safe_tx_hash ~ '^0x[0-9a-f]{64}$'),
  kind          text not null check (char_length(kind) between 1 and 40),
  label         text not null check (char_length(label) between 1 and 200),
  status        text not null default 'pending' check (status in ('pending', 'executed', 'failed', 'replaced', 'discarded')),
  created_by    text not null,
  created_at    timestamptz not null default now(),
  executed_tx   text,
  executed_by   text,
  executed_at   timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists safe_proposals_queue on app.safe_proposals (chain_id, safe, status, nonce);
create unique index if not exists safe_proposals_hash on app.safe_proposals (chain_id, safe_tx_hash) where status <> 'discarded';

create table if not exists app.safe_signatures (
  proposal_id  bigint not null references app.safe_proposals (id) on delete cascade,
  signer       text not null check (signer ~ '^0x[0-9a-f]{40}$'),
  signature    text not null check (signature ~ '^0x[0-9a-f]{130}$'),
  created_at   timestamptz not null default now(),
  primary key (proposal_id, signer)
);

-- On-chain history of the FeeVault and the Safe (withdrawals, executed Safe transactions, owner changes),
-- read from the chain by the API so it also shows actions done outside the panel (e.g. safe-tx.ps1).
create table if not exists app.treasury_events (
  chain_id   integer not null,
  address    text not null,
  block      bigint not null,
  log_index  integer not null,
  tx_hash    text not null,
  name       text not null,
  args       jsonb not null default '{}',
  block_time timestamptz,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists treasury_events_idx on app.treasury_events (chain_id, name, block desc);

create table if not exists app.treasury_cursor (
  chain_id   integer not null,
  scope      text not null,
  scanned_to bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, scope)
);

do $$
declare t text;
begin
  foreach t in array array['safe_proposals', 'safe_signatures', 'treasury_events', 'treasury_cursor'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists api_all on app.%I', t);
    execute format('create policy api_all on app.%I for all to stable_api using (true) with check (true)', t);
    execute format('grant select, insert, update, delete on app.%I to stable_api', t);
  end loop;
end $$;
grant usage, select on sequence app.safe_proposals_id_seq to stable_api;
