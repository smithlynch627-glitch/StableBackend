// Applies db/01_schema.sql. Needs an owner connection (the `postgres` user), not the limited stable_api role.
import { readFileSync } from 'node:fs';
import { getPool } from '../src/db.js';

const sql = readFileSync(new URL('../db/01_schema.sql', import.meta.url), 'utf8');
try {
  await getPool().query(sql);
  console.log('Schema applied. Next: run db/02_api_role.sql in the Supabase SQL editor and use stable_api in DATABASE_URL.');
} catch (e) {
  console.error('Schema failed:', e.message);
  console.error('Run this with the postgres user, or paste db/01_schema.sql into the Supabase SQL editor.');
  process.exitCode = 1;
}
await getPool().end();
