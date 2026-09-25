import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config, contractsReady } from './config.js';
import { HttpError } from './lib/http.js';
import { getPool } from './db.js';
import { applyCollectionFlags } from './indexer/core.js';
import { chainFees } from './lib/chain.js';
import meta from './routes/meta.js';
import collections from './routes/collections.js';
import tokens from './routes/tokens.js';
import activity from './routes/activity.js';
import users from './routes/users.js';
import drops from './routes/drops.js';
import orders from './routes/orders.js';
import uploads, { media } from './routes/uploads.js';
import admin from './routes/admin.js';
import share from './routes/share.js';
import support from './routes/support.js';
import { loadNetwork, watchNetwork } from './lib/network.js';

const app = express();
const blockedOrigins = new Set();
app.set('trust proxy', 1);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, // JSON API: nothing to render
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);
app.disable('x-powered-by');
app.use(
  cors({
    origin: (origin, cb) => {
      const ok = !origin || config.corsOrigins.includes(origin) || config.adminOrigins.includes(origin);
      if (!ok && !blockedOrigins.has(origin)) {
        blockedOrigins.add(origin);
        console.warn(`[cors] blocked ${origin}. Add it to CORS_ORIGINS (website) or ADMIN_ORIGINS (admin app) in .env and restart.`);
      }
      cb(null, ok);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  }),
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }));

app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));
const writeLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
app.use((req, res, next) => (req.method === 'GET' ? next() : writeLimit(req, res, next)));

app.use('/api', meta);
app.use('/api/collections', collections);
app.use('/api/tokens', tokens);
app.use('/api/activity', activity);
app.use('/api/users', users);
app.use('/api/drops', drops);
app.use('/api/orders', orders);
app.use('/api/uploads', uploads);
app.use('/api/media', media);
app.use('/api/admin', admin);
app.use('/api/share', share);
app.use('/api/support', support);

app.use((_req, res) => res.status(404).json({ error: 'Route not found', code: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large', code: 'too_large' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large', code: 'too_large' });
  const db = describeDbError(err);
  if (db) {
    console.error(`[db] ${db}`);
    return res.status(503).json({ error: db, code: 'database' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server', code: 'server_error' });
});

/** Turns Postgres/connection failures into a message that says what to fix. */
function describeDbError(err) {
  const code = err?.code;
  const msg = String(err?.message || '');
  if (code === '42P01') return 'Database tables are missing. Run db/01_schema.sql (npm run db:init)';
  if (code === 'ECONNRESET' || /Connection terminated unexpectedly/i.test(msg))
    return 'The database pooler closed the connection. Copy the host exactly from Supabase → Connect → Direct → Session pooler, use user stable_api.<project-ref> and port 5432';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN')
    return `Cannot reach the database (${code}). Check DATABASE_URL in backend/.env`;
  if (code === '28P01' || /password authentication failed/i.test(msg)) return 'Database password is wrong. Check DATABASE_URL';
  if (/Tenant or user not found/i.test(msg)) return 'Supabase pooler user is wrong. Use the Session pooler string (user looks like postgres.<project-ref>)';
  if (/self.signed|certificate/i.test(msg)) return 'Database SSL error. Check DATABASE_URL';
  if (/database .* does not exist/i.test(msg)) return 'Database name in DATABASE_URL does not exist';
  return null;
}

async function checkDatabase() {
  const host = (() => { try { return new URL(config.databaseUrl).host; } catch { return 'invalid DATABASE_URL'; } })();
  try {
    await getPool().query('select 1');
    const { rows } = await getPool().query(`select to_regclass('app.networks') as t`);
    if (!rows[0].t) {
      console.error(`[db] Connected to ${host}, but tables are missing. Run db/01_schema.sql (npm run db:init)`);
      return;
    }
    console.log(`[db] Connected to ${host} over ${/localhost|127\.0\.0\.1/.test(config.databaseUrl) ? 'a local socket' : config.databaseCa ? 'verified TLS' : 'TLS'}.`);
  } catch (e) {
    console.error(`[db] ${describeDbError(e) || e.message} (host: ${host})`);
  }
}

async function checkChain() {
  if (!contractsReady()) return;
  const fees = await chainFees();
  if (fees.marketFeeBps === null) console.error(`[chain] Cannot read the contracts through ${config.rpcUrl}. Check RPC_URL and the addresses.`);
  else console.log(`[chain] market fee ${fees.marketFeeBps / 100}%, mint fee ${fees.mintFeeBps / 100}%`);
  await applyCollectionFlags().catch(() => {});
}

async function start() {
  await checkDatabase();
  try {
    await loadNetwork();
    watchNetwork();
    console.log(`[network] ${config.networkName} (chain ${config.chainId})`);
  } catch (e) {
    console.error(`[network] ${describeDbError(e) || e.message}`);
  }
  app.listen(config.port, () => {
    console.log(`API listening on :${config.port}`);
    checkChain();
  });
}
start();
