-- =====================================================================================
-- STABLE: up to three extra images per collection (shown beside the logo on the mint page).
-- Run once in Supabase: SQL Editor → paste → Run. Safe to run again (idempotent).
-- Until this has run, the website keeps working; only saving extra images is refused.
-- =====================================================================================

do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname ~ '^chain_[0-9]+$' loop
    if to_regclass(format('%I.collections', s)) is not null then
      execute format($a$alter table %I.collections add column if not exists gallery jsonb not null default '[]'$a$, s);
      -- at most 3 links, stored as a JSON list
      execute format('alter table %I.collections drop constraint if exists collections_gallery_check', s);
      execute format($a$alter table %I.collections add constraint collections_gallery_check
        check (jsonb_typeof(gallery) = 'array' and jsonb_array_length(gallery) <= 3)$a$, s);
    end if;
  end loop;
end $$;

-- Chains added later get the column too (same definition as in 01_schema.sql).
create or replace function app.add_collection_gallery(p_chain_id integer)
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare s text := 'chain_' || p_chain_id::text;
begin
  if p_chain_id is null or p_chain_id <= 0 then raise exception 'bad chain id'; end if;
  if to_regclass(format('%I.collections', s)) is null then return; end if;
  execute format($a$alter table %I.collections add column if not exists gallery jsonb not null default '[]'$a$, s);
end $$;
revoke all on function app.add_collection_gallery(integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'stable_api') then
    execute 'grant execute on function app.add_collection_gallery(integer) to stable_api';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function app.add_collection_gallery(integer) from anon, authenticated';
  end if;
end $$;
