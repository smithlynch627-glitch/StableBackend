import { Router } from 'express';
import { many, one, q } from '../db.js';
import { addrParam, ah, bad, clampInt } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { BEST_LISTING_JOIN, COLLECTION_COLS, TOKEN_COLS } from '../lib/queries.js';

const r = Router();

const ORDER_SELECT = `select o.hash, o.kind, o.collection, o.token_id::text as token_id, o.maker, o.price_wei, o.currency,
  o.end_time, o.created_at, c.name as collection_name, c.slug as collection_slug, c.art_style,
  t.name as token_name, t.image_url as token_image, t.attributes as token_attributes
  from orders o join collections c on c.address = o.collection
  left join tokens t on t.collection = o.collection and t.token_id = o.token_id`;

r.put('/me', requireAuth, ah(async (req, res) => {
  const username = req.body?.username ? String(req.body.username).trim() : null;
  const bio = String(req.body?.bio || '').slice(0, 280);
  if (username && !/^[\p{L}\p{N}_.-]{3,24}$/u.test(username)) throw bad('Username must be 3–24 letters, numbers, _ . or -');
  try {
    const u = await one(
      `insert into app.users (address, username, bio) values ($1,$2,$3)
       on conflict (address) do update set username = excluded.username, bio = excluded.bio returning *`,
      [req.user, username, bio],
    );
    res.json({ user: u });
  } catch (e) {
    if (e.code === '23505') throw bad('That username is taken');
    throw e;
  }
}));

r.get('/:address', ah(async (req, res) => {
  const address = addrParam(req.params.address);
  const [user, counts] = await Promise.all([
    one(`select address, username, bio, created_at from app.users where address = $1`, [address]),
    one(
      `select (select count(*) from tokens where owner = $1)::int as owned,
              (select count(*) from orders where maker = $1 and kind = 'listing' and status = 'active')::int as listed,
              (select count(*) from orders where maker = $1 and kind <> 'listing' and status = 'active')::int as offers_made`,
      [address],
    ),
  ]);
  const created = await many(`select ${COLLECTION_COLS} from collections c where c.creator = $1 and not c.hidden order by c.created_at desc limit 50`, [address]);
  res.json({ user: user || { address, username: null, bio: '' }, counts, collections: created });
}));

r.get('/:address/tokens', ah(async (req, res) => {
  const address = addrParam(req.params.address);
  const limit = clampInt(req.query.limit, 1, 100, 60);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const rows = await many(
    `select ${TOKEN_COLS}, c.name as collection_name, c.slug as collection_slug, c.art_style, c.tradable, c.is_official, count(*) over() as total_count
     from tokens t ${BEST_LISTING_JOIN} join collections c on c.address = t.collection
     where t.owner = $1 and not c.hidden order by t.minted_at desc, t.token_id asc limit ${limit} offset ${offset}`,
    [address],
  );
  res.json({ tokens: rows.map(({ total_count, ...t }) => t), total: rows[0]?.total_count ?? 0 });
}));

r.get('/:address/listings', ah(async (req, res) => {
  const address = addrParam(req.params.address);
  res.json({ orders: await many(`${ORDER_SELECT} where o.maker = $1 and o.kind = 'listing' and o.status = 'active' order by o.created_at desc limit 200`, [address]) });
}));

r.get('/:address/offers-made', ah(async (req, res) => {
  const address = addrParam(req.params.address);
  res.json({ orders: await many(`${ORDER_SELECT} where o.maker = $1 and o.kind <> 'listing' and o.status = 'active' order by o.created_at desc limit 200`, [address]) });
}));

r.get('/:address/offers-received', ah(async (req, res) => {
  const address = addrParam(req.params.address);
  const orders = await many(
    `${ORDER_SELECT}
     where o.status = 'active' and o.maker <> $1 and (
       (o.kind = 'offer' and t.owner = $1) or
       (o.kind = 'collection_offer' and exists (select 1 from tokens x where x.collection = o.collection and x.owner = $1)))
     order by o.price_wei desc limit 200`,
    [address],
  );
  res.json({ orders });
}));

export default r;
