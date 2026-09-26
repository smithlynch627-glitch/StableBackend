// Signed StableMarket orders + transaction sync.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { many, one, q } from '../db.js';
import { ah, bad, notFound } from '../lib/http.js';
import { loadCollection } from '../lib/queries.js';
import { bulkSignatures, validateOrder } from '../lib/market.js';
import { refreshCollectionStats } from '../lib/stats.js';
import { getProvider, market } from '../lib/chain.js';
import { processLogs } from '../indexer/core.js';

const r = Router();
// Each of these asks the blockchain node several questions: limited per visitor so nobody can use us to flood it.
const limit = (n) => rateLimit({ windowMs: 60_000, limit: n, standardHeaders: 'draft-7', legacyHeaders: false });
const orderLimit = limit(40);
const bulkLimit = limit(8);
const syncLimit = limit(30);

/** Validates one signed order with the contract and stores it. */
async function saveOrder(raw, signature) {
  const col = await loadCollection(raw?.collection || '');
  const { order: o, hash } = await validateOrder(raw, signature);
  const kind = o.side === 0 ? 'listing' : o.anyToken ? 'collection_offer' : 'offer';
  const tokenId = o.anyToken ? null : o.tokenId;

  if (kind === 'listing') {
    // A cheaper listing that is still open would let buyers skip the new, higher price. The site cancels it on-chain
    // first; if our database has not seen that cancel yet, the contract is asked directly.
    const cheaper = await many(
      `select hash, counter from orders where collection = $1 and token_id = $2 and maker = $3 and kind = 'listing' and status = 'active'
         and end_time > now() and price_wei < $4`,
      [col.address, tokenId, o.maker, o.price],
    );
    for (const c of cheaper) {
      // The RPC node we reach can be a block behind the wallet's, so a just-sent cancel gets a few seconds.
      let state = null;
      for (let i = 0; i < 8 && !state; i++) {
        const [isCancelled, isFilled, counter] = await Promise.all([market().cancelled(c.hash), market().filled(c.hash), market().counters(o.maker)]);
        if (isCancelled || isFilled || BigInt(c.counter) < BigInt(counter)) state = isFilled ? 'filled' : 'cancelled';
        else if (i < 7) await new Promise((r) => setTimeout(r, 500));
      }
      if (!state) throw bad('Cancel your current listing before raising the price. A cheaper signed listing stays valid until it is cancelled.', 'raise_price');
      await q(`update orders set status = $2, updated_at = now() where hash = $1 and status = 'active'`, [c.hash, state]);
    }
  }

  const inserted = await one(
    `insert into orders (hash, chain_id, kind, collection, token_id, maker, price_wei, currency, end_time, counter, order_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9),$10,$11) on conflict (hash) do nothing returning hash`,
    [hash, config.chainId, kind, col.address, tokenId, o.maker, o.price, kind === 'listing' ? 'ETH' : 'WETH', Number(o.expiry), o.counter,
      JSON.stringify({ order: o, signature })],
  );
  if (inserted) {
    await q(
      `insert into activity (chain_id, type, collection, token_id, from_addr, price_wei, order_hash) values ($1,$2,$3,$4,$5,$6,$7)`,
      [config.chainId, kind === 'listing' ? 'list' : kind, col.address, tokenId, o.maker, o.price, hash],
    );
  }
  return { hash, kind, collection: col.address, inserted: Boolean(inserted) };
}

r.post('/', orderLimit, ah(async (req, res) => {
  const { order: raw, signature } = req.body || {};
  const out = await saveOrder(raw, signature);
  if (out.inserted) await refreshCollectionStats(out.collection);
  res.json({ hash: out.hash, kind: out.kind });
}));

/**
 * Bulk listing: { orders: [...], signature } where the signature covers all of them at once (EIP-712 BulkOrder).
 * Each order is checked with the contract exactly like a single one. Returns every hash, or the first problem.
 */
r.post('/bulk', bulkLimit, ah(async (req, res) => {
  const items = bulkSignatures(req.body?.orders, req.body?.signature);
  const saved = [];
  const failed = [];
  for (let i = 0; i < items.length; i += 5) {
    const part = await Promise.all(items.slice(i, i + 5).map((it) => saveOrder(it.order, it.signature).then(
      (ok) => ({ ok, tokenId: it.order.tokenId }),
      (err) => ({ err: err.message, tokenId: it.order.tokenId, collection: it.order.collection }),
    )));
    for (const p of part) (p.ok ? saved.push({ hash: p.ok.hash, tokenId: p.tokenId, collection: p.ok.collection }) : failed.push(p));
  }
  for (const c of new Set(saved.map((x) => x.collection))) await refreshCollectionStats(c);
  if (!saved.length) throw bad(failed[0]?.err || 'No order could be saved');
  res.json({ saved, failed });
}));

/** A wallet's open listings for many items at once: ?maker=0x…&items=0xcollection:1,0xcollection:2 (max 100). */
r.get('/active', ah(async (req, res) => {
  const maker = String(req.query.maker || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(maker)) throw bad('maker is required');
  const items = String(req.query.items || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 100)
    .map((x) => x.match(/^(0x[0-9a-f]{40}):(\d{1,78})$/)).filter(Boolean);
  if (!items.length) return res.json({ orders: [] });
  const cols = items.map((m) => m[1]);
  const ids = items.map((m) => m[2]);
  const rows = await many(
    `select o.hash, o.kind, o.collection, o.token_id::text as token_id, o.maker, o.price_wei, o.currency, o.status, o.end_time, o.order_json
     from orders o join unnest($2::text[], $3::numeric[]) as want(collection, token_id)
       on o.collection = want.collection and o.token_id = want.token_id
     where o.maker = $1 and o.kind = 'listing' and o.status = 'active' and o.end_time > now()
     order by o.collection, o.token_id, o.price_wei limit 500`,
    [maker, cols, ids],
  );
  res.json({ orders: rows });
}));

/** A wallet's open listings for one item (used to cancel them all before listing at a higher price). */
r.get('/', ah(async (req, res) => {
  const collection = String(req.query.collection || '').toLowerCase();
  const maker = String(req.query.maker || '').toLowerCase();
  const tokenId = String(req.query.token || '');
  if (!/^0x[0-9a-f]{40}$/.test(collection) || !/^0x[0-9a-f]{40}$/.test(maker) || !/^\d{1,78}$/.test(tokenId)) throw bad('collection, token and maker are required');
  const rows = await many(
    `select hash, kind, token_id::text as token_id, maker, price_wei, currency, status, end_time, order_json
     from orders where collection = $1 and token_id = $2 and maker = $3 and kind = 'listing' and status = 'active' and end_time > now()
     order by price_wei asc limit 20`,
    [collection, tokenId, maker],
  );
  res.json({ orders: rows });
}));

r.get('/:hash', ah(async (req, res) => {
  const o = await one(
    `select hash, kind, collection, token_id::text as token_id, maker, price_wei, currency, status, end_time, order_json
     from orders where hash = $1`,
    [String(req.params.hash).toLowerCase()],
  );
  if (!o) throw notFound('Order not found');
  res.json({ order: o });
}));

/** Process one confirmed transaction right away so the UI does not wait for the indexer. */
r.post('/sync', syncLimit, ah(async (req, res) => {
  const hash = String(req.body?.txHash || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw bad('Invalid transaction hash');
  // The wallet saw the receipt on one RPC node; the node we reach may be a block behind, so retry briefly.
  let receipt = null;
  for (let i = 0; i < 8 && !receipt; i++) {
    receipt = await getProvider().getTransactionReceipt(hash).catch(() => null);
    if (!receipt) await new Promise((r) => setTimeout(r, 400));
  }
  if (!receipt) return res.status(202).json({ queued: true }); // the indexer picks it up within seconds
  try {
    res.json(await processLogs(receipt.logs));
  } catch (e) {
    console.warn('[sync]', hash, e.message);
    res.status(202).json({ queued: true });
  }
}));

export default r;
