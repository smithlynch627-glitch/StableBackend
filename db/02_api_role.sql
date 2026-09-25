-- Run once in the Supabase SQL Editor, AFTER 01_schema.sql.
-- Gives the backend its own least-privilege login.
--
-- Safe to re-run: the password below is only applied the FIRST time (while stable_api cannot log in yet).
-- It never overwrites a password you already set. To change the password later, run on its own:
--   alter role stable_api with login password 'your-new-long-random-password';
do $$
begin
  if not (select rolcanlogin from pg_roles where rolname = 'stable_api') then
    alter role stable_api with login password 'CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD';
    raise notice 'stable_api can now log in. Set a real password with: alter role stable_api with login password ''...'';';
  end if;
end $$;
alter role stable_api set statement_timeout = '15s';
alter role stable_api set idle_in_transaction_session_timeout = '30s';

-- Backend DATABASE_URL (Supabase → Connect → Direct → Session pooler), user is stable_api.<project-ref>:
-- postgresql://stable_api.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
