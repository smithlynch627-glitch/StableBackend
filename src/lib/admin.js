import { config } from '../config.js';
import { one, q } from '../db.js';
import { HttpError } from './http.js';

const RANK = { support: 1, admin: 2, owner: 3 };
const ADMIN_SESSION_MAX_AGE = 12 * 3600; // admin actions need a sign-in from the last 12 hours

/** Role is looked up fresh on every request (never trusted from the token). */
export async function roleOf(address) {
  if (!address) return null;
  if (config.rootAdmins.includes(address)) return 'owner';
  const row = await one(`select role from app.admins where address = $1`, [address]);
  return row?.role || null;
}

export function requireRole(min) {
  return async (req, _res, next) => {
    try {
      if (!req.user) throw new HttpError(401, 'Sign in with your wallet first', 'auth_required');
      if (Date.now() / 1000 - (req.tokenIat || 0) > ADMIN_SESSION_MAX_AGE) {
        throw new HttpError(401, 'Admin session is older than 12 hours. Sign in again.', 'auth_stale');
      }
      const role = await roleOf(req.user);
      if (!role) {
        const w = `${req.user.slice(0, 6)}…${req.user.slice(-4)}`;
        throw new HttpError(403, `This wallet (${w}) is not an admin. Add it to ADMIN_ADDRESSES in backend/.env and restart the API, or ask an owner to add it in the Team tab.`, 'not_admin');
      }
      if (RANK[role] < RANK[min]) throw new HttpError(403, `Your role (${role}) cannot open this. Ask an owner for more access.`, 'forbidden');
      req.role = role;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export async function audit(req, action, target = null, details = {}) {
  await q(`insert into app.audit_log (actor, action, target, details, ip) values ($1,$2,$3,$4,$5)`, [
    req.user || 'system', action, target, JSON.stringify(details), req.ip || null,
  ]).catch((e) => console.error('[audit]', e.message));
}
