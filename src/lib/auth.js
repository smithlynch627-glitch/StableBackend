// Wallet sign-in with a standard "Sign-In with Ethereum" (EIP-4361) message.
// - The message names the website it is for (domain + URI). Wallets warn when a different site asks for it,
//   so a phishing page can't collect a STABLE sign-in.
// - The API rebuilds the exact message and compares it: nothing can be added to or hidden in it.
// - Sessions from the admin site get their own token type (12 hours) that the public site can never obtain.
import jwt from 'jsonwebtoken';
import { getAddress, verifyMessage } from 'ethers';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { HttpError, addrParam, bad } from './http.js';

const STATEMENT = 'Sign in to STABLE: NFTs Launchpad & Marketplace. This request will not trigger a transaction or cost any gas.';
const NONCE_MINUTES = 10;
const PUBLIC_AUD = 'stable-api';
const ADMIN_AUD = 'stable-admin';
const JWT_OPTS = { algorithms: ['HS256'], issuer: 'stable' };

const allowedOrigins = () => [...config.corsOrigins, ...config.adminOrigins];

/** The site (origin) the sign-in is for: the browser's Origin header when it is one of ours. */
function siteFor(origin) {
  const o = String(origin || '').trim().replace(/\/+$/, '').toLowerCase();
  if (o && allowedOrigins().includes(o)) return o;
  if (o) throw new HttpError(403, 'Sign-in is only available on the STABLE website', 'origin');
  return config.corsOrigins[0]; // scripts / tests without a browser
}

export function buildSignInMessage({ address, uri, nonce, issuedAt, expirationTime }) {
  const domain = new URL(uri).host;
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    getAddress(address),
    '',
    STATEMENT,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${config.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join('\n');
}

function parseSignIn(message) {
  const m = /^([^\s]+) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})\n\n[^\n]*\n\nURI: ([^\n]+)\nVersion: 1\nChain ID: (\d+)\nNonce: ([0-9a-zA-Z]{8,64})\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/.exec(message);
  if (!m) return null;
  return { domain: m[1], address: m[2], uri: m[3], chainId: Number(m[4]), nonce: m[5], issuedAt: m[6], expirationTime: m[7] };
}

export async function createNonce(rawAddress, origin) {
  const address = addrParam(rawAddress);
  const uri = siteFor(origin);
  // One nonce per wallet. It is kept (not replaced) while it still has 5+ minutes left, so someone asking for
  // nonces for your wallet can't keep breaking your sign-in.
  const fresh = crypto.randomUUID().replace(/-/g, '');
  const row = await one(
    `insert into app.auth_nonces (address, nonce, expires_at) values ($1,$2, now() + interval '${NONCE_MINUTES} minutes')
     on conflict (address) do update set nonce = excluded.nonce, expires_at = excluded.expires_at
       where app.auth_nonces.expires_at < now() + interval '5 minutes'
     returning nonce`,
    [address, fresh],
  );
  const nonce = row?.nonce || (await one(`select nonce from app.auth_nonces where address = $1`, [address]))?.nonce || fresh;
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expirationTime = new Date(now + NONCE_MINUTES * 60_000).toISOString();
  return { message: buildSignInMessage({ address, uri, nonce, issuedAt, expirationTime }) };
}

export async function verifySignIn({ address: rawAddress, message, signature }, origin) {
  const address = addrParam(rawAddress);
  if (typeof message !== 'string' || typeof signature !== 'string' || message.length > 1000 || signature.length > 200) {
    throw bad('Missing signature');
  }
  const p = parseSignIn(message);
  const expired = () => new HttpError(401, 'Sign-in expired. Try again.', 'nonce');
  if (!p || p.address.toLowerCase() !== address || p.chainId !== config.chainId) throw expired();
  // The message must be for one of our sites, and exactly what this API would have written.
  const uri = p.uri.replace(/\/+$/, '').toLowerCase();
  if (!allowedOrigins().includes(uri) || new URL(uri).host !== p.domain) throw expired();
  if (origin && String(origin).replace(/\/+$/, '').toLowerCase() !== uri) throw expired();
  const issued = Date.parse(p.issuedAt);
  const expires = Date.parse(p.expirationTime);
  if (!(issued <= Date.now() + 60_000 && expires > Date.now() && expires - issued <= NONCE_MINUTES * 60_000)) throw expired();
  if (buildSignInMessage({ address, uri, nonce: p.nonce, issuedAt: p.issuedAt, expirationTime: p.expirationTime }) !== message) throw expired();

  let recovered;
  try {
    recovered = verifyMessage(message, signature).toLowerCase();
  } catch {
    throw new HttpError(401, 'Signature could not be verified', 'signature');
  }
  if (recovered !== address) throw new HttpError(401, 'Signature does not match wallet', 'signature');
  // Single use: removed in the same statement that checks it (a signed message can't be replayed).
  const used = await one(`delete from app.auth_nonces where address = $1 and nonce = $2 and expires_at > now() returning nonce`, [address, p.nonce]);
  if (!used) throw expired();

  const user = await one(
    `insert into app.users (address) values ($1) on conflict (address) do update set address = excluded.address returning is_banned`,
    [address],
  );
  if (user?.is_banned) throw new HttpError(403, 'This wallet is suspended. Contact support.', 'banned');
  bans.delete(address);
  const admin = config.adminOrigins.includes(uri);
  const token = jwt.sign({ sub: address }, config.jwtSecret, {
    algorithm: 'HS256', expiresIn: admin ? '12h' : '7d', audience: admin ? ADMIN_AUD : PUBLIC_AUD, issuer: 'stable',
  });
  return { token, address };
}

function readToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || token.length > 2000) return null;
  const payload = jwt.verify(token, config.jwtSecret, { ...JWT_OPTS, audience: [PUBLIC_AUD, ADMIN_AUD] });
  const address = String(payload.sub).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('bad subject');
  return { address, iat: Number(payload.iat), admin: payload.aud === ADMIN_AUD };
}

// Suspended wallets lose access right away (checked on every signed-in request, cached for 30 seconds).
const bans = new Map();
async function isBanned(address) {
  const hit = bans.get(address);
  if (hit && Date.now() - hit.at < 30_000) return hit.banned;
  const row = await one(`select is_banned from app.users where address = $1`, [address]).catch(() => null);
  if (bans.size > 20_000) bans.clear();
  bans.set(address, { banned: Boolean(row?.is_banned), at: Date.now() });
  return Boolean(row?.is_banned);
}
export const forgetBan = (address) => bans.delete(String(address || '').toLowerCase());

export async function requireAuth(req, _res, next) {
  let t;
  try {
    t = readToken(req);
  } catch {
    return next(new HttpError(401, 'Session expired. Sign in again.', 'auth_expired'));
  }
  if (!t) return next(new HttpError(401, 'Sign in with your wallet first', 'auth_required'));
  try {
    if (await isBanned(t.address)) return next(new HttpError(403, 'This wallet is suspended. Contact support.', 'banned'));
  } catch (e) {
    return next(e);
  }
  req.user = t.address;
  req.tokenIat = t.iat;
  req.adminSession = t.admin;
  next();
}

/** Admin API: only sessions signed on the admin site (a public-site token is refused). */
export function requireAdminSession(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.adminSession) return next(new HttpError(401, 'Sign in on the admin site', 'admin_session'));
    next();
  });
}

export function optionalAuth(req, _res, next) {
  try {
    const t = readToken(req);
    if (t) {
      req.user = t.address;
      req.tokenIat = t.iat;
      req.adminSession = t.admin;
    }
  } catch {}
  next();
}
