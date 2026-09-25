// Signed StableMarket orders + transaction sync.
import { Router } from 'express';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { ah, bad, notFound } from '../lib/http.js';
import { loadCollection } from '../lib/queries.js';
import { validateOrder } from '../lib/market.js';
import { refreshCollectionStats } from '../lib/stats.js';
import { getProvider } from '../lib/chain.js';
import { processLogs } from '../indexer/core.js';

const r = Router();

r.post('/', ah(async (req, res) => {
  const { order: raw, signature } = req.body || {};
  const col = await loadCollection(raw?.collection || '');
  const { order: o, hash } = await validateOrder(raw, signature);
  const kind = o.side === 0 ? 'listing' : o.anyToken ? 'collection_offer' : 'offer';
  const tokenId = o.anyToken ? null : o.tokenId;

  if (kind === 'listing') {
    const current = await one(
      `select price_wei from orders where collection = $1 and token_id = $2 and maker = $3 and kind = 'listing' and status = 'active'
       order by price_wei asc limit 1`,
      [col.address, tokenId, o.maker],
    );
    if (current && BigInt(current.price_wei) < BigInt(o.price)) {
      throw bad('Cancel your current listing before raising the price. A cheaper signed listing stays valid until it is cancelled.', 'raise_price');
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
    await refreshCollectionStats(col.address);
  }
  res.json({ hash, kind });
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
r.post('/sync', ah(async (req, res) => {
  const hash = String(req.body?.txHash || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw bad('Invalid transaction hash');
  const receipt = await getProvider().getTransactionReceipt(hash);
  if (!receipt) throw bad('Transaction not confirmed yet');
  res.json(await processLogs(receipt.logs));
}));

export default r;
