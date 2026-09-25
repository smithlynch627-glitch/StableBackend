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

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Holders with their holdings, sample images, and trading history in this collection.
 * PnL = received from sales + items held x floor - spent on mints and purchases (floor 0 if nothing is listed).
 */
r.get('/:key/holders', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const order = { held: 'held desc, owner', pnl: 'pnl desc, held desc', volume: 'volume desc, held desc' }[req.query.sort] || 'held desc, owner';
  const floor = col.floor_wei || '0';
  const rows = await many(
    `with holders as (
       select owner, count(*)::int as held from tokens
       where collection = $1 and owner is not null and owner <> $2 group by owner),
     buys as (select to_addr as addr, count(*)::int as n, sum(price_wei) as amt from activity where collection = $1 and type = 'sale' group by 1),
     sells as (select from_addr as addr, count(*)::int as n, sum(price_wei) as amt from activity where collection = $1 and type = 'sale' group by 1),
     mints as (select to_addr as addr, count(*)::int as n, coalesce(sum(price_wei), 0) as amt from activity where collection = $1 and type = 'mint' group by 1),
     rows as (
       select h.owner, h.held, coalesce(m.n, 0) as minted, coalesce(b.n, 0) as bought, coalesce(s.n, 0) as sold,
         coalesce(m.amt, 0) + coalesce(b.amt, 0) as spent, coalesce(s.amt, 0) as received,
         coalesce(b.amt, 0) + coalesce(s.amt, 0) as volume,
         coalesce(s.amt, 0) + h.held * $3::numeric - coalesce(m.amt, 0) - coalesce(b.amt, 0) as pnl
       from holders h left join buys b on b.addr = h.owner left join sells s on s.addr = h.owner left join mints m on m.addr = h.owner)
     select rows.*, u.username, count(*) over() as total_count,
       (select coalesce(json_agg(x), '[]') from (
          select t.token_id::text as token_id, t.name, t.image_url from tokens t
          where t.collection = $1 and t.owner = rows.owner order by t.rarity_rank asc nulls last, t.token_id limit 5) x) as samples
     from rows left join app.users u on u.address = rows.owner
     order by ${order} limit ${limit} offset ${offset}`,
    [col.address, ZERO, floor],
  );
  const supply = Number(col.total_supply) || 0;
  const summary = await one(
    `with h as (select owner, count(*)::int as held from tokens where collection = $1 and owner is not null and owner <> $2 group by owner)
     select count(*)::int as holders, coalesce(sum(held), 0)::int as items,
       count(*) filter (where held = 1)::int as b1, count(*) filter (where held between 2 and 3)::int as b2,
       count(*) filter (where held between 4 and 10)::int as b3, count(*) filter (where held between 11 and 25)::int as b4,
       count(*) filter (where held > 25)::int as b5,
       coalesce((select sum(held) from (select held from h order by held desc limit 10) t), 0)::int as top10
     from h`,
    [col.address, ZERO],
  );
  res.json({
    holders: rows.map(({ total_count, ...h }, i) => ({ ...h, rank: offset + i + 1, share: supply ? h.held / supply : 0 })),
    total: rows[0]?.total_count ?? summary.holders,
    summary: {
      holders: summary.holders,
      supply,
      uniquePct: supply ? summary.holders / supply : 0,
      avgHeld: summary.holders ? summary.items / summary.holders : 0,
      top10Pct: supply ? summary.top10 / supply : 0,
      distribution: [
        { label: '1', count: summary.b1 }, { label: '2-3', count: summary.b2 }, { label: '4-10', count: summary.b3 },
        { label: '11-25', count: summary.b4 }, { label: '25+', count: summary.b5 },
      ],
    },
    floorWei: col.floor_wei,
  });
}));

const RANGES = {
  '24h': { since: "now() - interval '24 hours'", bucket: '1 hour', prev: "now() - interval '48 hours'" },
  '7d': { since: "now() - interval '7 days'", bucket: '6 hours', prev: "now() - interval '14 days'" },
  '30d': { since: "now() - interval '30 days'", bucket: '1 day', prev: "now() - interval '60 days'" },
  all: { since: "'epoch'::timestamptz", bucket: '1 day', prev: null },
};

/** Volume, sales, price history, floor history, top sales and the rarest listed items. */
r.get('/:key/analytics', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const range = RANGES[req.query.range] ? String(req.query.range) : '7d';
  const R = RANGES[range];
  const [totals, prev, series, sales, floor, topSales, rareListed, mintStats] = await Promise.all([
    one(`select count(*)::int as sales, coalesce(sum(price_wei), 0) as volume, avg(price_wei)::numeric(78,0) as avg,
           min(price_wei) as min, max(price_wei) as max, count(distinct to_addr)::int as buyers, count(distinct from_addr)::int as sellers
         from activity where collection = $1 and type = 'sale' and created_at >= ${R.since}`, [col.address]),
    R.prev
      ? one(`select count(*)::int as sales, coalesce(sum(price_wei), 0) as volume from activity
             where collection = $1 and type = 'sale' and created_at >= ${R.prev} and created_at < ${R.since}`, [col.address])
      : Promise.resolve(null),
    many(`select date_bin($2::interval, created_at, 'epoch'::timestamptz) as t, count(*)::int as sales, sum(price_wei) as volume,
            avg(price_wei)::numeric(78,0) as avg, min(price_wei) as min, max(price_wei) as max
          from activity where collection = $1 and type = 'sale' and created_at >= ${R.since} group by 1 order by 1`, [col.address, R.bucket]),
    many(`select created_at as t, price_wei as price, token_id::text as token_id from activity
          where collection = $1 and type = 'sale' and created_at >= ${R.since} order by created_at desc limit 1000`, [col.address]),
    many(`select date_bin($2::interval, taken_at, 'epoch'::timestamptz) as t, min(floor_wei) as floor, max(listed_count)::int as listed,
            max(owners_count)::int as owners
          from snapshots where collection = $1 and taken_at >= ${R.since} group by 1 order by 1`, [col.address, R.bucket]),
    many(`select a.token_id::text as token_id, a.price_wei, a.created_at, a.from_addr, a.to_addr, a.tx_hash, t.name, t.image_url, t.rarity_rank
          from activity a left join tokens t on t.collection = a.collection and t.token_id = a.token_id
          where a.collection = $1 and a.type = 'sale' and a.created_at >= ${R.since} order by a.price_wei desc, a.created_at desc limit 10`, [col.address]),
    many(`select t.token_id::text as token_id, t.name, t.image_url, t.rarity_rank, o.price_wei, o.maker
          from orders o join tokens t on t.collection = o.collection and t.token_id = o.token_id
          where o.collection = $1 and o.kind = 'listing' and o.status = 'active' and t.rarity_rank is not null
          order by t.rarity_rank asc, o.price_wei asc limit 10`, [col.address]),
    one(`select count(*)::int as minted, count(distinct to_addr)::int as minters, coalesce(sum(price_wei), 0) as revenue
         from activity where collection = $1 and type = 'mint'`, [col.address]),
  ]);
  res.json({
    range,
    totals: { ...totals, floor: col.floor_wei, bestOffer: col.best_offer_wei, owners: col.owners_count, listed: col.listed_count, supply: col.total_supply },
    previous: prev,
    series,
    sales: sales.reverse(),
    floor,
    topSales,
    rareListed,
    mint: mintStats,
  });
}));

function weiOrZero(eth) {
  const n = Number(eth);
  if (!Number.isFinite(n) || n < 0) return '0';
  return BigInt(Math.round(n * 1e9)) * 1_000_000_000n + '';
}

export default r;
