import pg from 'pg';
import { config } from './config.js';

// numeric → string (wei stays exact), int8 → number
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

function ssl() {
  if (isLocal) return false;
  if (config.databaseCa) return { ca: config.databaseCa, rejectUnauthorized: true }; // verified TLS
  return { rejectUnauthorized: false }; // encrypted, but set DATABASE_CA_CERT to also verify the server
}

let chainId = null;
let pool = makePool(null);

function makePool(forChain) {
  const path = forChain ? `chain_${forChain}, app, public` : 'app, public';
  // search_path is set inside connect(), so it is guaranteed before the pool hands the client out.
  class ScopedClient extends pg.Client {
    connect(cb) {
      // Settings are applied with SET after connecting. Poolers (Supabase Supavisor, PgBouncer) reject most
      // startup parameters, so nothing but user/password/database is sent in the connection handshake.
      const p = super
        .connect()
        .then(() => super.query(`set search_path to ${path}; set statement_timeout = 15000`))
        .then(() => undefined);
      if (typeof cb === 'function') {
        p.then(() => cb(), cb);
        return undefined;
      }
      return p;
    }
  }
  const p = new pg.Pool({
    Client: ScopedClient,
    connectionString: config.databaseUrl,
    ssl: ssl(),
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  p.on('error', (e) => console.error('[db] pool error', e.message));
  return p;
}

/** Point every query at the data schema of a chain (chain_<id>). Global tables live in `app`. */
export async function useChain(id) {
  if (id === chainId) return;
  const old = pool;
  pool = makePool(id);
  chainId = id;
  setTimeout(() => old.end().catch(() => {}), 10_000);
}

export const currentChainSchema = () => (chainId ? `chain_${chainId}` : null);
export const getPool = () => pool;
export const q = (text, params = []) => pool.query(text, params);
export const one = async (text, params = []) => (await pool.query(text, params)).rows[0] || null;
export const many = async (text, params = []) => (await pool.query(text, params)).rows;

export async function tx(fn) {
  const client = await pool.connect();
  const h = {
    q: (t, p = []) => client.query(t, p),
    one: async (t, p = []) => (await client.query(t, p)).rows[0] || null,
    many: async (t, p = []) => (await client.query(t, p)).rows,
  };
  try {
    await client.query('BEGIN');
    const out = await fn(h);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
