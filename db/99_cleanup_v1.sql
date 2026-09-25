-- Optional: remove tables left in `public` by the first (test-mode) version. Nothing new uses them.
drop table if exists public.fee_ledger, public.indexer_state, public.allowlists, public.drops, public.activity,
  public.orders, public.tokens, public.collections, public.auth_nonces, public.users cascade;
