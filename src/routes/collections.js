import { Router } from 'express';
import { many, one } from '../db.js';
import { ah, clampInt } from '../lib/http.js';
import { BEST_LISTING_JOIN, COLLECTION_COLS, TOKEN_COLS, loadCollection, loadDrop, traitCounts } from '../lib/queries.js';

const r = Router();

const SORTS = {
  volume_24h: 'c.volume_24h_wei desc, c.volume_wei desc',
  volume: 'c.volume_wei desc',
  floor: 'c.floor_wei desc nulls last',
  new: 'c.created_at desc',
  sales: 'c.sales_count desc',
};

r.get('/', ah(async (req, res) => {
  const sort = SORTS[req.query.sort] || SORTS.volume_24h;
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 100000, 0);
  const rows = await many(
    `select ${COLLECTION_COLS} from collections c where not c.hidden order by c.is_official desc, c.featured desc, ${sort} limit $1 offset $2`,
    [limit, offset],
  );
  res.json({ collections: rows });
}));

r.get('/:key', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  res.json({ collection: col, drop: await loadDrop(col) });
}));

r.get('/:key/traits', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  res.json({ traits: await traitCounts(col.address), total: col.total_supply });
}));

const TOKEN_SORTS = {
  price_asc: 'l.price_wei asc nulls last, t.token_id asc',
  price_desc: 'l.price_wei desc nulls last, t.token_id asc',
  id_asc: 't.token_id asc',
  id_desc: 't.token_id desc',
  rarity: 't.rarity_rank asc nulls last, t.token_id asc',
  recent: 'l.created_at desc nulls last, t.token_id asc',
};

r.get('/:key/tokens', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const params = [col.address];
  const where = [`t.collection = $1`, `t.owner is not null`];
  const add = (v) => (params.push(v), `$${params.length}`);

  if (req.query.status === 'listed') where.push('l.hash is not null');
  if (req.query.min) where.push(`l.price_wei >= ${add(weiOrZero(req.query.min))}`);
  if (req.query.max) where.push(`l.price_wei <= ${add(weiOrZero(req.query.max))}`);
  if (req.query.owner) where.push(`t.owner = ${add(String(req.query.owner).toLowerCase())}`);
  const qs = String(req.query.q || '').trim();
  if (/^#?\d{1,10}$/.test(qs)) where.push(`t.token_id = ${add(qs.replace('#', ''))}`);
  else if (qs) where.push(`t.name ilike ${add(`%${qs.replace(/[%_]/g, '')}%`)}`);

  if (req.query.traits) {
    let traits = {};
    try { traits = JSON.parse(String(req.query.traits)); } catch {}
    for (const [type, values] of Object.entries(traits)) {
      if (!Array.isArray(values) || !values.length) continue;
      const ors = values.slice(0, 30).map((v) => `t.attributes @> ${add(JSON.stringify([{ trait_type: type, value: String(v) }]))}::jsonb`);
      where.push(`(${ors.join(' or ')})`);
    }
  }

  const sort = TOKEN_SORTS[req.query.sort] || TOKEN_SORTS.price_asc;
  const limit = clampInt(req.query.limit, 1, 100, 40);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const rows = await many(
    `select ${TOKEN_COLS}, count(*) over() as total_count
     from tokens t ${BEST_LISTING_JOIN}
     where ${where.join(' and ')}
     order by ${sort} limit ${limit} offset ${offset}`,
    params,
  );
  res.json({ tokens: rows.map(({ total_count, ...t }) => t), total: rows[0]?.total_count ?? 0 });
}));

r.get('/:key/offers', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const offers = await many(
    `select hash, kind, token_id::text as token_id, maker, price_wei, currency, end_time, created_at
     from orders where collection = $1 and kind in ('offer','collection_offer') and status = 'active'
     order by price_wei desc limit 100`,
    [col.address],
  );
  res.json({ offers });
}));

/** Cheapest active listings for sweeping (excludes the buyer's own items). */
r.get('/:key/sweep', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const count = clampInt(req.query.count, 1, 50, 10);
  const exclude = String(req.query.exclude || '').toLowerCase();
  const orders = await many(
    `select hash, token_id::text as token_id, maker, price_wei, order_json from orders
     where collection = $1 and kind = 'listing' and status = 'active' and maker <> $2
     order by price_wei asc limit $3`,
    [col.address, exclude, count],
  );
  res.json({ orders });
}));

function weiOrZero(eth) {
  const n = Number(eth);
  if (!Number.isFinite(n) || n < 0) return '0';
  return BigInt(Math.round(n * 1e9)) * 1_000_000_000n + '';
}

export default r;
