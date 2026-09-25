import jwt from 'jsonwebtoken';
import { verifyMessage } from 'ethers';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { HttpError, addrParam, bad } from './http.js';

export function buildSignInMessage(address, nonce, issuedAt) {
  return [
    'Sign in to STABLE: NFTs Launchpad & Marketplace.',
    '',
    'This request will not trigger a transaction or cost any gas.',
    '',
    `Wallet: ${address}`,
    `Chain ID: ${config.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export async function createNonce(rawAddress) {
  const address = addrParam(rawAddress);
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const issuedAt = new Date().toISOString();
  await q(
    `insert into app.auth_nonces (address, nonce, expires_at) values ($1,$2, now() + interval '10 minutes')
     on conflict (address) do update set nonce = excluded.nonce, expires_at = excluded.expires_at`,
    [address, nonce],
  );
  return { message: buildSignInMessage(address, nonce, issuedAt) };
}

export async function verifySignIn({ address: rawAddress, message, signature }) {
  const address = addrParam(rawAddress);
  if (typeof message !== 'string' || typeof signature !== 'string' || message.length > 1000) throw bad('Missing signature');
  // Nonce is single-use: deleted in the same statement that reads it (no replay).
  const row = await one(`delete from app.auth_nonces where address = $1 and expires_at > now() returning nonce`, [address]);
  if (!row || !message.includes(`Nonce: ${row.nonce}`) || !message.includes(`Wallet: ${address}`)) {
    throw new HttpError(401, 'Sign-in expired. Try again.', 'nonce');
  }
  let recovered;
  try {
    recovered = verifyMessage(message, signature).toLowerCase();
  } catch {
    throw new HttpError(401, 'Signature could not be verified', 'signature');
  }
  if (recovered !== address) throw new HttpError(401, 'Signature does not match wallet', 'signature');
  const user = await one(
    `insert into app.users (address) values ($1) on conflict (address) do update set address = excluded.address returning is_banned`,
    [address],
  );
  if (user?.is_banned) throw new HttpError(403, 'This wallet is suspended. Contact support.', 'banned');
  const token = jwt.sign({ sub: address }, config.jwtSecret, { expiresIn: '7d', audience: 'stable-api', issuer: 'stable' });
  return { token, address };
}

function readToken(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const payload = jwt.verify(token, config.jwtSecret, { audience: 'stable-api', issuer: 'stable' });
  return { address: String(payload.sub).toLowerCase(), iat: Number(payload.iat) };
}

export function requireAuth(req, _res, next) {
  try {
    const t = readToken(req);
    if (!t) return next(new HttpError(401, 'Sign in with your wallet first', 'auth_required'));
    req.user = t.address;
    req.tokenIat = t.iat;
    next();
  } catch {
    next(new HttpError(401, 'Session expired. Sign in again.', 'auth_expired'));
  }
}

export function optionalAuth(req, _res, next) {
  try {
    const t = readToken(req);
    if (t) {
      req.user = t.address;
      req.tokenIat = t.iat;
    }
  } catch {}
  next();
}
