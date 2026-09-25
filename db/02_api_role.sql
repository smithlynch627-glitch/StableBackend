-- Run once in the Supabase SQL Editor, AFTER 01_schema.sql.
-- Gives the backend its own least-privilege login. Replace the password with a long random one.
alter role stable_api with login password 'CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD';
alter role stable_api set statement_timeout = '15s';
alter role stable_api set idle_in_transaction_session_timeout = '30s';

-- Backend DATABASE_URL (Supabase → Connect → Session pooler), user is stable_api.<project-ref>:
-- postgresql://stable_api.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
