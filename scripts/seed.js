// Seeds test-mode data: STABLE COWS (official collection) plus a few sample launchpad drops.
// Usage:  npm run seed            (only if empty)
//         npm run seed -- --reset (wipe marketplace tables first)
import { readFileSync } from 'node:fs';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { pool, q } from '../src/db.js';
import { cowAttributes, cowRarityRanks } from '../src/lib/traits.js';
import { refreshAllStats } from '../src/lib/stats.js';

const RESET = process.argv.includes('--reset');
const CLEAR = process.argv.includes('--clear');
const CHAIN = Number(process.env.CHAIN_ID || 91342);
const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(2222);
const between = (a, b) => a + rand() * (b - a);
const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const addr = () => '0x' + hex(40);
const hash = () => '0x' + hex(64);
const eth = (x) => BigInt(Math.round(x * 1e9)) * 1_000_000_000n;

async function bulkInsert(table, cols, rows) {
  const CHUNK = Math.floor(30000 / cols.length);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params = [];
    const values = part.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`);
    await q(`insert into ${table} (${cols.join(',')}) values ${values.join(',')}`, params);
  }
}

// ── schema ────────────────────────────────────────────────────────────────────
await q(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
if (CLEAR) {
  await q(`truncate collections, tokens, orders, activity, drops, allowlists, fee_ledger, indexer_state restart identity cascade`);
  console.log('Cleared all marketplace data (users kept). Ready for real mode.');
  await pool.end();
  process.exit(0);
}
if (RESET) {
  await q(`truncate collections, tokens, orders, activity, drops, allowlists, fee_ledger restart identity cascade`);
  console.log('Reset marketplace tables.');
} else {
  const { rows } = await q(`select count(*)::int as n from collections`);
  if (rows[0].n > 0) {
    console.log('Database already has collections. Run with --reset to reseed.');
    await pool.end();
    process.exit(0);
  }
}

// Whale-heavy holder distribution
const holders = Array.from({ length: 220 }, addr);
const holderWeights = holders.map((_, i) => (i < 12 ? 10 : i < 50 ? 3 : 1));
const totalW = holderWeights.reduce((a, b) => a + b, 0);
const randomHolder = () => {
  let r = rand() * totalW;
  for (let i = 0; i < holders.length; i++) if ((r -= holderWeights[i]) <= 0) return holders[i];
  return holders[0];
};

const events = []; // { t, kind, ... } processed chronologically
const tokens = new Map(); // key collection:id → { owner, acquired, lastSale }
const orders = [];
const fees = [];
const collections = [];
const drops = [];

function addCollection(c) {
  collections.push({ volume: 0n, sales: 0, ...c });
  return collections[collections.length - 1];
}

// ── STABLE COWS ───────────────────────────────────────────────────────────────
const cows = addCollection({
  address: '0x57ab1e000000000000000000000000000000c0a5',
  slug: 'stable-cows',
  name: 'STABLE COWS',
  symbol: 'COWS',
  description:
    'The official collection of the GIWA Launchpad & Marketplace. 2,222 hand-drawn cow PFPs with patterned hides and custom fits, built for the GIWA community.',
  image_url: '/stable-cows/pfp.png',
  banner_url: '/stable-cows/banner.png',
  art_style: 'cow',
  creator: '0x57ab1e00000000000000000000000000000c0a55',
  royalty_bps: 500,
  max_supply: 2222,
  verified: true,
  is_official: true,
  twitter: 'https://x.com/StableCows',
  mintPriceWei: [eth(0.00015), eth(0.0002)],
  floorBase: 0.0011,
});
drops.push({
  collection: cows.address,
  featured: true,
  phases: [
    { name: 'Whitelist', start: new Date(now - 3 * DAY).toISOString(), end: new Date(now - DAY).toISOString(), priceWei: eth(0.00015).toString(), maxPerWallet: 2, allowlistId: null },
    { name: 'Public', start: new Date(now - DAY).toISOString(), end: new Date(now + 6 * DAY).toISOString(), priceWei: eth(0.0002).toString(), maxPerWallet: 10, allowlistId: null },
  ],
});
const cowRanks = cowRarityRanks(2222);
for (let id = 1; id <= 1137; id++) {
  const wl = id <= 400;
  const t = wl ? between(now - 3 * DAY, now - DAY) : between(now - DAY, now - 2 * HOUR);
  events.push({ t, kind: 'mint', col: cows, id, to: randomHolder(), price: wl ? eth(0.00015) : eth(0.0002) });
}

// ── Sample creator drops (test data) ─────────────────────────────────────────
const hanok = addCollection({
  address: addr(), slug: 'hanok-tiles', name: 'Hanok Tiles', symbol: 'HANOK', art_style: 'tile',
  description: 'Generative roof-tile studies inspired by hanok rooftops. Sample drop for test mode.',
  creator: addr(), royalty_bps: 400, max_supply: 500, verified: true, floorBase: 0.0006,
});
drops.push({
  collection: hanok.address, featured: false,
  phases: [{ name: 'Public', start: new Date(now - 6 * HOUR).toISOString(), end: new Date(now + 2 * DAY).toISOString(), priceWei: eth(0.0001).toString(), maxPerWallet: 5, allowlistId: null }],
});
for (let id = 1; id <= 188; id++) events.push({ t: between(now - 6 * HOUR, now - 20 * 60_000), kind: 'mint', col: hanok, id, to: randomHolder(), price: eth(0.0001) });

const pebbles = addCollection({
  address: addr(), slug: 'giwa-pebbles', name: 'GIWA Pebbles', symbol: 'PBBL', art_style: 'tile',
  description: 'Three hundred smooth monochrome pebbles. Sold out sample drop for test mode.',
  creator: addr(), royalty_bps: 250, max_supply: 300, verified: false, floorBase: 0.0009,
});
drops.push({
  collection: pebbles.address, featured: false,
  phases: [{ name: 'Public', start: new Date(now - 9 * DAY).toISOString(), end: new Date(now - 7 * DAY).toISOString(), priceWei: eth(0.00008).toString(), maxPerWallet: 3, allowlistId: null }],
});
for (let id = 1; id <= 300; id++) events.push({ t: between(now - 9 * DAY, now - 7.5 * DAY), kind: 'mint', col: pebbles, id, to: randomHolder(), price: eth(0.00008) });

const signal = addCollection({
  address: addr(), slug: 'seoul-signal-club', name: 'Seoul Signal Club', symbol: 'SSC', art_style: 'tile',
  description: 'Night signs and street signals from Seoul, redrawn in black and white. Upcoming sample drop.',
  creator: addr(), royalty_bps: 500, max_supply: 1000, verified: false, floorBase: 0,
});
const alList = holders.slice(0, 40);
const alTree = StandardMerkleTree.of(alList.map((a) => [a]), ['address']);
const { rows: alRows } = await q(
  `insert into allowlists (root, addresses, tree) values ($1,$2,$3) returning id`,
  [alTree.root, JSON.stringify(alList), JSON.stringify(alTree.dump())],
);
drops.push({
  collection: signal.address, featured: false,
  phases: [
    { name: 'Allowlist', start: new Date(now + 2 * DAY).toISOString(), end: new Date(now + 3 * DAY).toISOString(), priceWei: eth(0.00012).toString(), maxPerWallet: 2, allowlistId: alRows[0].id },
    { name: 'Public', start: new Date(now + 3 * DAY).toISOString(), end: new Date(now + 10 * DAY).toISOString(), priceWei: eth(0.00018).toString(), maxPerWallet: 5, allowlistId: null },
  ],
});

// ── Secondary sales ───────────────────────────────────────────────────────────
function addSales(col, count, maxId, fromT) {
  for (let i = 0; i < count; i++) {
    const id = 1 + Math.floor(rand() * maxId);
    const rarityBoost = col === cows && cowRanks.get(id) <= 110 ? 2.5 : 1;
    const price = eth(col.floorBase * rarityBoost * Math.exp(between(-0.35, 0.6)));
    events.push({ t: between(fromT, now - 5 * 60_000), kind: 'sale', col, id, price });
  }
}
addSales(cows, 340, 1137, now - 2.6 * DAY);
addSales(hanok, 36, 188, now - 5 * HOUR);
addSales(pebbles, 90, 300, now - 7.4 * DAY);

events.sort((a, b) => a.t - b.t);
const activity = [];
const tokenRows = [];
for (const e of events) {
  const key = `${e.col.address}:${e.id}`;
  if (e.kind === 'mint') {
    tokens.set(key, { owner: e.to, acquired: e.t, lastSale: null });
    const txh = hash();
    activity.push([CHAIN, 'mint', e.col.address, e.id, ZERO, e.to, e.price.toString(), txh, null, new Date(e.t)]);
    fees.push(['mint', e.col.address, ((e.price * 1000n) / 10000n).toString(), txh, new Date(e.t)]);
  } else {
    const tk = tokens.get(key);
    if (!tk || tk.acquired > e.t) continue;
    let buyer = randomHolder();
    if (buyer === tk.owner) buyer = holders[(holders.indexOf(buyer) + 1) % holders.length];
    const txh = hash();
    activity.push([CHAIN, 'sale', e.col.address, e.id, tk.owner, buyer, e.price.toString(), txh, hash(), new Date(e.t)]);
    fees.push(['trade', e.col.address, ((e.price * 200n) / 10000n).toString(), txh, new Date(e.t)]);
    tk.owner = buyer; tk.acquired = e.t; tk.lastSale = e.price;
    e.col.volume += e.price; e.col.sales += 1;
  }
}

// ── Listings and offers (current state) ──────────────────────────────────────
function addListings(col, count, maxId) {
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const id = 1 + Math.floor(rand() * maxId);
    if (used.has(id)) continue;
    used.add(id);
    const tk = tokens.get(`${col.address}:${id}`);
    if (!tk) continue;
    const rare = col === cows && cowRanks.get(id) <= 110 ? 3 : 1;
    const price = eth(col.floorBase * rare * Math.exp(between(-0.15, 1.1)));
    const created = Math.max(tk.acquired + 60_000, now - between(0.2, 40) * HOUR);
    const h = hash();
    orders.push([h, CHAIN, 'listing', col.address, id, tk.owner, price.toString(), 'ETH', 'active', new Date(created), new Date(now + between(3, 30) * DAY)]);
    activity.push([CHAIN, 'list', col.address, id, tk.owner, null, price.toString(), null, h, new Date(created)]);
  }
}
addListings(cows, 170, 1137);
addListings(hanok, 34, 188);
addListings(pebbles, 40, 300);

function addOffers(col, itemOffers, collectionOffers, maxId) {
  for (let i = 0; i < itemOffers; i++) {
    const id = 1 + Math.floor(rand() * maxId);
    const tk = tokens.get(`${col.address}:${id}`);
    if (!tk) continue;
    let maker = randomHolder();
    if (maker === tk.owner) continue;
    const price = eth(col.floorBase * between(0.55, 0.92));
    const created = now - between(0.1, 30) * HOUR;
    const h = hash();
    orders.push([h, CHAIN, 'offer', col.address, id, maker, price.toString(), 'WETH', 'active', new Date(created), new Date(now + between(1, 14) * DAY)]);
    activity.push([CHAIN, 'offer', col.address, id, maker, null, price.toString(), null, h, new Date(created)]);
  }
  for (let i = 0; i < collectionOffers; i++) {
    const maker = randomHolder();
    const price = eth(col.floorBase * between(0.6, 0.85));
    const created = now - between(0.1, 20) * HOUR;
    const h = hash();
    orders.push([h, CHAIN, 'collection_offer', col.address, null, maker, price.toString(), 'WETH', 'active', new Date(created), new Date(now + between(2, 10) * DAY)]);
    activity.push([CHAIN, 'collection_offer', col.address, null, maker, null, price.toString(), null, h, new Date(created)]);
  }
}
addOffers(cows, 40, 8, 1137);
addOffers(hanok, 8, 3, 188);
addOffers(pebbles, 10, 3, 300);

// ── Write everything ─────────────────────────────────────────────────────────
await bulkInsert(
  'collections',
  ['address', 'chain_id', 'slug', 'name', 'symbol', 'description', 'image_url', 'banner_url', 'art_style', 'creator', 'royalty_bps',
    'royalty_receiver', 'max_supply', 'verified', 'is_official', 'is_demo', 'twitter', 'volume_wei', 'sales_count', 'created_at'],
  collections.map((c, i) => [c.address, CHAIN, c.slug, c.name, c.symbol, c.description, c.image_url || null, c.banner_url || null,
    c.art_style, c.creator, c.royalty_bps, c.creator, c.max_supply, c.verified, Boolean(c.is_official), true, c.twitter || null,
    c.volume.toString(), c.sales, new Date(now - (10 - i) * DAY)]),
);
await bulkInsert(
  'drops', ['collection', 'phases', 'platform_fee_bps', 'featured'],
  drops.map((d) => [d.collection, JSON.stringify(d.phases), 1000, d.featured]),
);
for (const [key, tk] of tokens) {
  const [collection, idStr] = key.split(':');
  const id = Number(idStr);
  const col = collections.find((c) => c.address === collection);
  const isCow = col === cows;
  tokenRows.push([collection, id, tk.owner, `${col.name} #${id}`, JSON.stringify(isCow ? cowAttributes(id) : []), isCow ? cowRanks.get(id) : null,
    tk.lastSale ? tk.lastSale.toString() : null]);
}
await bulkInsert('tokens', ['collection', 'token_id', 'owner', 'name', 'attributes', 'rarity_rank', 'last_sale_wei'], tokenRows);
await bulkInsert('orders', ['hash', 'chain_id', 'kind', 'collection', 'token_id', 'maker', 'price_wei', 'currency', 'status', 'created_at', 'end_time'], orders);
activity.sort((a, b) => a[9] - b[9]);
await bulkInsert('activity', ['chain_id', 'type', 'collection', 'token_id', 'from_addr', 'to_addr', 'price_wei', 'tx_hash', 'order_hash', 'created_at'], activity);
await bulkInsert('fee_ledger', ['source', 'collection', 'amount_wei', 'tx_hash', 'created_at'], fees);
await refreshAllStats();

console.log(`Seeded ${collections.length} collections, ${tokenRows.length} tokens, ${orders.length} orders, ${activity.length} activity rows.`);
await pool.end();
