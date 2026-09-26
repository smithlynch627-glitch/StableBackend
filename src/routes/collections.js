import { Router } from 'express';
import { many, one } from '../db.js';
import { ah, clampInt, microCache } from '../lib/http.js';
import { BEST_LISTING_JOIN, COLLECTION_COLS, NO_TRAIT, TOKEN_COLS, loadCollection, loadDrop, traitCounts } from '../lib/queries.js';
import { maybeRepair } from '../indexer/core.js';

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
  maybeRepair(col);
  res.json({ collection: col, drop: await loadDrop(col) });
}));

r.get('/:key/traits', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const [traits, ranked] = await Promise.all([
    traitCounts(col.address),
    one(`select count(*)::int as n, max(rarity_rank)::int as max from tokens where collection = $1 and rarity_rank is not null`, [col.address]),
  ]);
  res.json({ traits, total: col.total_supply, ranked: ranked.n, maxRank: ranked.max });
}));

const TOKEN_SORTS = {
  price_asc: 'l.price_wei asc nulls last, t.token_id asc',
  price_desc: 'l.price_wei desc nulls last, t.token_id asc',
  recent: 'l.created_at desc nulls last, t.token_id asc',
  rarity: 't.rarity_rank asc nulls last, t.token_id asc',
  rarity_desc: 't.rarity_rank desc nulls last, t.token_id asc',
  offer_desc: 'bo.price_wei desc nulls last, t.token_id asc',
  last_sale_desc: 't.last_sale_wei desc nulls last, t.token_id asc',
  last_sale_asc: 't.last_sale_wei asc nulls last, t.token_id asc',
  id_asc: 't.token_id asc',
  id_desc: 't.token_id desc',
};

/** Best open offer made on one token (collection-wide offers are shown separately). */
const BEST_OFFER_JOIN = `left join lateral (
  select o.price_wei from orders o
  where o.collection = t.collection and o.token_id = t.token_id and o.kind = 'offer' and o.status = 'active' and o.end_time > now()
  order by o.price_wei desc limit 1) bo on true`;

/**
 * Items with every filter the market page offers:
 * status (all | listed | unlisted | offers), price range (ETH), rarity rank range, traits (any value within a
 * trait type, all trait types together), owner, search by name or #id, and sort.
 */
r.get('/:key/tokens', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const params = [col.address];
  const where = [`t.collection = $1`, `t.owner is not null`];
  const add = (v) => (params.push(v), `$${params.length}`);
  const sortKey = TOKEN_SORTS[req.query.sort] ? String(req.query.sort) : 'price_asc';
  const status = String(req.query.status || 'all');
  const needOffer = sortKey === 'offer_desc' || status === 'offers';

  if (status === 'listed') where.push('l.hash is not null');
  else if (status === 'unlisted') where.push('l.hash is null');
  else if (status === 'offers') where.push('bo.price_wei is not null');
  // A price range only makes sense for listed items.
  const min = priceWei(req.query.min);
  const max = priceWei(req.query.max);
  if (min !== null) where.push(`l.price_wei >= ${add(min)}`);
  if (max !== null) where.push(`l.price_wei <= ${add(max)}`);
  const rankMin = Number.parseInt(String(req.query.rank_min ?? ''), 10);
  const rankMax = Number.parseInt(String(req.query.rank_max ?? ''), 10);
  if (Number.isFinite(rankMin) && rankMin > 0) where.push(`t.rarity_rank >= ${add(rankMin)}`);
  if (Number.isFinite(rankMax) && rankMax > 0) where.push(`t.rarity_rank <= ${add(rankMax)}`);
  if (req.query.owner) where.push(`t.owner = ${add(String(req.query.owner).toLowerCase())}`);
  const qs = String(req.query.q || '').trim().slice(0, 80);
  if (/^#?\d{1,20}$/.test(qs)) where.push(`t.token_id = ${add(qs.replace('#', ''))}`);
  else if (qs) where.push(`t.name ilike ${add(`%${qs.replace(/[%_\\]/g, '')}%`)}`);

  if (req.query.traits) {
    let traits = {};
    try { traits = JSON.parse(String(req.query.traits)); } catch {}
    for (const [type, values] of Object.entries(traits || {}).slice(0, 30)) {
      if (!Array.isArray(values) || !values.length) continue;
      // Compared as text, so numbers in metadata (5) match the filter value ("5"). "__none__" = item has no such trait.
      const attrs = `jsonb_array_elements(case when jsonb_typeof(t.attributes) = 'array' then t.attributes else '[]'::jsonb end)`;
      const typeP = add(String(type));
      const vals = values.slice(0, 50).map(String);
      const real = vals.filter((v) => v !== NO_TRAIT);
      const ors = [];
      if (real.length) ors.push(`exists (select 1 from ${attrs} a where a->>'trait_type' = ${typeP} and a->>'value' = any(${add(real)}::text[]))`);
      if (vals.includes(NO_TRAIT)) ors.push(`(jsonb_typeof(t.attributes) = 'array' and jsonb_array_length(t.attributes) > 0 and not exists (select 1 from ${attrs} a where a->>'trait_type' = ${typeP}))`);
      where.push(`(${ors.join(' or ')})`);
    }
  }

  const limit = clampInt(req.query.limit, 1, 100, 40);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const rows = await many(
    `select ${TOKEN_COLS}, ${needOffer ? 'bo.price_wei' : 'null::numeric'} as best_offer_wei, count(*) over() as total_count
     from tokens t ${BEST_LISTING_JOIN} ${needOffer ? BEST_OFFER_JOIN : ''}
     where ${where.join(' and ')}
     order by ${TOKEN_SORTS[sortKey]} limit ${limit} offset ${offset}`,
    params,
  );
  res.json({ tokens: rows.map(({ total_count, ...t }) => t), total: Number(rows[0]?.total_count ?? 0) });
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
r.get('/:key/holders', microCache(15_000), ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const SORT = { held: 'held', pnl: 'pnl', volume: 'volume', spent: 'spent', minted: 'minted', bought: 'bought', sold: 'sold' };
  const key = SORT[req.query.sort] || 'held';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const order = `${key} ${dir}, held desc, owner`;
  const floor = col.floor_wei || '0';
  const params = [col.address, ZERO, floor];
  const add = (v) => (params.push(v), `$${params.length}`);
  const filters = [];
  // Who to show: everyone, minters, buyers, sellers, holders of several items, or one address / name.
  const type = String(req.query.type || 'all');
  if (type === 'minters') filters.push('minted > 0');
  else if (type === 'buyers') filters.push('bought > 0');
  else if (type === 'sellers') filters.push('sold > 0');
  else if (type === 'profit') filters.push('pnl > 0');
  else if (type === 'loss') filters.push('pnl < 0');
  const minHeld = clampInt(req.query.min_held, 0, 1_000_000, 0);
  if (minHeld > 1) filters.push(`held >= ${add(minHeld)}`);
  const qs = String(req.query.q || '').trim().toLowerCase().slice(0, 64);
  if (qs) filters.push(`(rows.owner like ${add(`%${qs.replace(/[%_\\]/g, '')}%`)} or lower(u.username) like ${add(`%${qs.replace(/[%_\\]/g, '')}%`)})`);
  const rows = await many(
    `with holders as (
       select owner, count(*)::int as held from tokens
       where collection = $1 and owner is not null and owner <> $2 group by owner),
     buys as (select to_addr as addr, count(*)::int as n, sum(price_wei) as amt from activity where collection = $1 and type = 'sale' group by 1),
     sells as (select from_addr as addr, count(*)::int as n, sum(price_wei) as amt from activity where collection = $1 and type = 'sale' group by 1),
     mints as (select to_addr as addr, count(*)::int as n, coalesce(sum(price_wei), 0) as amt from activity where collection = $1 and type = 'mint' group by 1),
     ranked as (select owner, row_number() over (order by held desc, owner)::int as rank from holders),
     rows as (
       select h.owner, h.held, coalesce(m.n, 0) as minted, coalesce(b.n, 0) as bought, coalesce(s.n, 0) as sold,
         coalesce(m.amt, 0) + coalesce(b.amt, 0) as spent, coalesce(s.amt, 0) as received,
         coalesce(b.amt, 0) + coalesce(s.amt, 0) as volume,
         coalesce(s.amt, 0) + h.held * $3::numeric - coalesce(m.amt, 0) - coalesce(b.amt, 0) as pnl, rk.rank
       from holders h join ranked rk using (owner)
       left join buys b on b.addr = h.owner left join sells s on s.addr = h.owner left join mints m on m.addr = h.owner)
     select rows.*, u.username, count(*) over() as total_count,
       (select coalesce(json_agg(x), '[]') from (
          select t.token_id::text as token_id, t.name, t.image_url, t.rarity_rank from tokens t
          where t.collection = $1 and t.owner = rows.owner order by t.rarity_rank asc nulls last, t.token_id limit 5) x) as samples
     from rows left join app.users u on u.address = rows.owner
     ${filters.length ? `where ${filters.join(' and ')}` : ''}
     order by ${order} limit ${limit} offset ${offset}`,
    params,
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
    // rank = position by items held (stays the same whatever the sort or filter).
    holders: rows.map(({ total_count, ...h }) => ({ ...h, share: supply ? h.held / supply : 0 })),
    total: Number(rows[0]?.total_count ?? 0),
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
r.get('/:key/analytics', microCache(30_000), ah(async (req, res) => {
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

/** "0.05" ETH → wei as text; empty or invalid → null (no limit). */
function priceWei(v) {
  const str = String(v ?? '').trim();
  if (!/^\d{0,12}(\.\d{0,18})?$/.test(str) || !/\d/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  return (BigInt(whole || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18))).toString();
}

export default r;
