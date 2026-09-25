import { Router } from 'express';
import { many, one } from '../db.js';
import { ah } from '../lib/http.js';
import { COLLECTION_COLS, publicConfig } from '../lib/queries.js';
import { createNonce, requireAuth, verifySignIn } from '../lib/auth.js';
import { roleOf } from '../lib/admin.js';
import { networkStatus } from '../lib/network.js';

const r = Router();

r.get('/health', ah(async (_req, res) => {
  await one('select 1');
  const st = networkStatus();
  // 503 until the active network (and its chain_<id> tables) is loaded, with the reason.
  res.status(st.chain ? 200 : 503).json({ ok: Boolean(st.chain), ...st, time: new Date().toISOString() });
}));

r.get('/config', ah(async (_req, res) => res.json(await publicConfig())));

r.post('/auth/nonce', ah(async (req, res) => res.json(await createNonce(req.body?.address))));
r.post('/auth/verify', ah(async (req, res) => res.json(await verifySignIn(req.body || {}))));
r.get('/auth/me', requireAuth, ah(async (req, res) => res.json({ address: req.user, role: await roleOf(req.user) })));

r.get('/search', ah(async (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 64);
  if (!term) return res.json({ collections: [] });
  const collections = await many(
    `select ${COLLECTION_COLS} from collections c
     where not c.hidden and (c.name ilike $1 or c.symbol ilike $1 or c.address = lower($2))
     order by c.is_official desc, c.volume_wei desc limit 6`,
    [`%${term.replace(/[%_]/g, '')}%`, term],
  );
  res.json({ collections });
}));

r.get('/stats', ah(async (_req, res) => {
  const s = await one(
    `select (select count(*) from collections)::int as collections,
            (select coalesce(sum(price_wei),0) from activity where type = 'sale' and created_at > now() - interval '24 hours') as volume_24h_wei,
            (select count(*) from activity where type = 'sale' and created_at > now() - interval '24 hours')::int as sales_24h,
            (select count(*) from activity where type = 'mint')::int as mints`,
  );
  res.json(s);
}));

export default r;
