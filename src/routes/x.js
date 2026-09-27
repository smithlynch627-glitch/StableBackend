// Connect an X (Twitter) account to a wallet, so a collection's X link is a verified account.
// OAuth 2.0 authorization code flow with PKCE. The ONLY X API call is GET /2/users/me (to learn the @username);
// the access token is revoked right after and never stored. Nothing is posted and no other X data is read.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { HttpError, ah, forbidden } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';

const r = Router();
const limiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const xReady = () => Boolean(config.x.clientId && config.x.redirectUri);

/** Connection status of the signed-in wallet. */
r.get('/me', requireAuth, ah(async (req, res) => {
  const u = await one(`select x_username, x_connected_at from app.users where address = $1`, [req.user]);
  res.json({ enabled: xReady(), connected: Boolean(u?.x_username), username: u?.x_username || null, connectedAt: u?.x_connected_at || null });
}));

/** Starts the connection: returns the X authorize URL (open it in a new window). */
r.post('/start', limiter, requireAuth, ah(async (req, res) => {
  if (!xReady()) throw new HttpError(503, 'X connection is not set up on this marketplace yet.', 'x_off');
  const origin = String(req.headers.origin || '').replace(/\/+$/, '').toLowerCase();
  if (!config.corsOrigins.includes(origin)) throw forbidden('Connect X from the STABLE website');
  const path = String(req.body?.returnPath || '/create');
  // A path on this site only ("//host" would leave it).
  const returnPath = /^\/(?!\/)[a-z0-9/_-]{0,80}$/i.test(path) && !path.includes('//') ? path : '/create';
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  await q(`delete from app.x_oauth where expires_at < now()`);
  await q(
    `insert into app.x_oauth (state, address, verifier, return_to, expires_at) values ($1,$2,$3,$4, now() + interval '10 minutes')`,
    [state, req.user, verifier, `${origin}${returnPath}`],
  );
  const u = new URL(config.x.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.x.clientId);
  u.searchParams.set('redirect_uri', config.x.redirectUri);
  u.searchParams.set('scope', 'users.read tweet.read'); // the minimum X requires for GET /2/users/me
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  res.json({ url: u.toString() });
}));

async function xFetch(path, init) {
  const res = await fetch(`${config.x.apiBase}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X ${path} ${res.status}: ${body.error_description || body.detail || body.error || body.title || 'failed'}`);
  return body;
}
const clientAuth = () => (config.x.clientSecret ? { authorization: `Basic ${Buffer.from(`${config.x.clientId}:${config.x.clientSecret}`).toString('base64')}` } : {});
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined));

/** X sends the user back here. One-time state, bound to the wallet that started it; then back to the website. */
r.get('/callback', limiter, ah(async (req, res) => {
  const state = String(req.query.state || '').slice(0, 100);
  const row = state ? await one(`delete from app.x_oauth where state = $1 returning address, verifier, return_to, expires_at`, [state]) : null;
  if (!row) return res.status(400).type('text/plain').send('This X connection link was already used or has expired. Go back to STABLE and press "Connect X" again.');
  const back = new URL(row.return_to);
  const done = (status, user) => {
    const u = new URL('/x/connected', back.origin);
    u.searchParams.set('status', status);
    u.searchParams.set('next', back.pathname);
    if (user) u.searchParams.set('user', user);
    res.redirect(303, u.toString());
  };
  if (new Date(row.expires_at) < new Date()) return done('expired');
  if (req.query.error) return done('denied');
  const code = String(req.query.code || '');
  if (!code) return done('error');
  try {
    const tok = await xFetch('/2/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...clientAuth() },
      body: form({ grant_type: 'authorization_code', code, redirect_uri: config.x.redirectUri, code_verifier: row.verifier, client_id: config.x.clientId }),
    });
    const me = await xFetch('/2/users/me', { headers: { authorization: `Bearer ${tok.access_token}` } });
    // Done with X: give the token back so it can't be used for anything else.
    xFetch('/2/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...clientAuth() },
      body: form({ token: tok.access_token, token_type_hint: 'access_token', client_id: config.x.clientId }),
    }).catch(() => undefined);
    const username = String(me?.data?.username || '');
    const id = String(me?.data?.id || '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username) || !/^\d{1,30}$/.test(id)) throw new Error('X returned no username');
    await q(
      `insert into app.users (address, x_user_id, x_username, x_connected_at) values ($1,$2,$3, now())
       on conflict (address) do update set x_user_id = excluded.x_user_id, x_username = excluded.x_username, x_connected_at = now()`,
      [row.address, id, username],
    );
    return done('ok', username);
  } catch (e) {
    console.warn('[x] connect failed:', e.message);
    return done('error');
  }
}));

/** Disconnect (a different X account can be connected afterwards). */
r.delete('/', requireAuth, ah(async (req, res) => {
  await q(`update app.users set x_user_id = null, x_username = null, x_connected_at = null where address = $1`, [req.user]);
  res.json({ ok: true });
}));

/** The X link for a collection: always the owner's connected account (never typed by hand). */
export async function connectedXLink(address) {
  const u = await one(`select x_username from app.users where address = $1`, [address]);
  return u?.x_username ? `https://x.com/${u.x_username}` : null;
}

export default r;
