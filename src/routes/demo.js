// Test mode: simulates every marketplace and launchpad action in the database,
// so the full UI can be used on GIWA testnet before the contracts are deployed.
import { Router } from 'express';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { parseEther } from 'ethers';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { ah, bad, clampInt, ethToWei, forbidden, randomHash, tokenIdParam } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { loadCollection } from '../lib/queries.js';
import { dropState } from '../lib/drops.js';
import { cowAttributes, cowRarityRanks } from '../lib/traits.js';
import { refreshCollectionStats } from '../lib/stats.js';
import { saveCollectionAndDrop } from './drops.js';

const r = Router();
r.use((_req, _res, next) => (config.demoMode ? next() : next(bad('Test mode is off. Use real transactions.', 'real_mode'))));
r.use(requireAuth);

const fee = (wei, bps) => (BigInt(wei) * BigInt(bps)) / 10000n;
const days = (v) => clampInt(v, 1, 180, 7);

r.post('/mint', ah(async (req, res) => {
  const col = await loadCollection(req.body?.collection);
  const qty = clampInt(req.body?.quantity, 1, 50, 1);
  const user = req.user;
  const result = await tx(async (db) => {
    const c = await db.one(`select * from collections where address = $1 for update`, [col.address]);
    const d = await db.one(`select phases, platform_fee_bps from drops where collection = $1`, [c.address]);
    if (!d) throw bad('This collection has no drop');
    const st = dropState(d.phases, c.total_supply, c.max_supply);
    if (!st.livePhase) throw bad(st.status === 'sold_out' ? 'This drop is sold out' : 'Minting is not open right now');
    const phase = d.phases[st.livePhase.index];
    if (phase.allowlistId) {
      const al = await db.one(`select 1 from allowlists where id = $1 and addresses @> $2::jsonb`, [phase.allowlistId, JSON.stringify([user])]);
      if (!al) throw bad(`Your wallet is not eligible for the ${phase.name} phase`, 'not_allowlisted');
    }
    if (phase.maxPerWallet) {
      const m = await db.one(
        `select count(*)::int as n from activity where collection = $1 and type = 'mint' and to_addr = $2 and created_at >= $3`,
        [c.address, user, phase.start],
      );
      const left = phase.maxPerWallet - m.n;
      if (qty > left) throw bad(left > 0 ? `You can mint ${left} more in this phase` : 'You reached the limit for this phase', 'wallet_limit');
    }
    if (c.max_supply && c.total_supply + qty > c.max_supply) throw bad(`Only ${c.max_supply - c.total_supply} left`, 'supply');
    const { n: maxId } = await db.one(`select coalesce(max(token_id), 0)::int as n from tokens where collection = $1`, [c.address]);
    const ranks = c.art_style === 'cow' ? cowRarityRanks(c.max_supply || 10000) : null;
    const txHash = randomHash();
    const ids = [];
    for (let i = 1; i <= qty; i++) {
      const id = maxId + i;
      ids.push(id);
      await db.q(
        `insert into tokens (collection, token_id, owner, name, attributes, rarity_rank) values ($1,$2,$3,$4,$5,$6)
         on conflict (collection, token_id) do update set owner = excluded.owner`,
        [c.address, id, user, `${c.name} #${id}`, JSON.stringify(c.art_style === 'cow' ? cowAttributes(id) : []), ranks?.get(id) ?? null],
      );
      await db.q(
        `insert into activity (type, collection, token_id, from_addr, to_addr, price_wei, tx_hash)
         values ('mint',$1,$2,'0x0000000000000000000000000000000000000000',$3,$4,$5)`,
        [c.address, id, user, phase.priceWei, txHash],
      );
    }
    const total = BigInt(phase.priceWei) * BigInt(qty);
    const platform = fee(total, d.platform_fee_bps);
    if (platform > 0n) await db.q(`insert into fee_ledger (source, collection, amount_wei, tx_hash) values ('mint',$1,$2,$3)`, [c.address, platform.toString(), txHash]);
    await db.q(`update collections set total_supply = total_supply + $2 where address = $1`, [c.address, qty]);
    return { tokenIds: ids.map(String), txHash, totalWei: total.toString(), platformFeeWei: platform.toString() };
  });
  await refreshCollectionStats(col.address);
  res.json(result);
}));

r.post('/list', ah(async (req, res) => {
  const col = await loadCollection(req.body?.collection);
  const tokenId = tokenIdParam(req.body?.tokenId);
  const price = ethToWei(req.body?.price);
  const out = await tx(async (db) => {
    const t = await db.one(`select owner from tokens where collection = $1 and token_id = $2 for update`, [col.address, tokenId]);
    if (!t || t.owner !== req.user) throw forbidden('You do not own this item');
    await db.q(
      `update orders set status = 'cancelled', updated_at = now()
       where collection = $1 and token_id = $2 and maker = $3 and kind = 'listing' and status = 'active'`,
      [col.address, tokenId, req.user],
    );
    const hash = randomHash();
    await db.q(
      `insert into orders (hash, kind, collection, token_id, maker, price_wei, end_time) values ($1,'listing',$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
      [hash, col.address, tokenId, req.user, price, String(days(req.body?.durationDays))],
    );
    await db.q(`insert into activity (type, collection, token_id, from_addr, price_wei, order_hash) values ('list',$1,$2,$3,$4,$5)`, [col.address, tokenId, req.user, price, hash]);
    return { hash };
  });
  await refreshCollectionStats(col.address);
  res.json(out);
}));

r.post('/cancel', ah(async (req, res) => {
  const hashes = [].concat(req.body?.hash || req.body?.hashes || []).slice(0, 50).map(String);
  if (!hashes.length) throw bad('Nothing to cancel');
  const touched = new Set();
  await tx(async (db) => {
    for (const hash of hashes) {
      const o = await db.one(`update orders set status = 'cancelled', updated_at = now() where hash = $1 and maker = $2 and status = 'active' returning *`, [hash, req.user]);
      if (!o) continue;
      touched.add(o.collection);
      await db.q(
        `insert into activity (type, collection, token_id, from_addr, price_wei, order_hash) values ($1,$2,$3,$4,$5,$6)`,
        [o.kind === 'listing' ? 'delist' : 'offer_cancel', o.collection, o.token_id, req.user, o.price_wei, hash],
      );
    }
  });
  for (const c of touched) await refreshCollectionStats(c);
  res.json({ cancelled: touched.size > 0 });
}));

async function transfer(db, { collection, tokenId, from, to, price, orderHash, txHash }) {
  await db.q(`update tokens set owner = $3, last_sale_wei = $4 where collection = $1 and token_id = $2`, [collection, tokenId, to, price]);
  await db.q(
    `update orders set status = 'cancelled', updated_at = now()
     where collection = $1 and token_id = $2 and kind = 'listing' and status = 'active' and maker = $3`,
    [collection, tokenId, from],
  );
  await db.q(
    `insert into activity (type, collection, token_id, from_addr, to_addr, price_wei, order_hash, tx_hash) values ('sale',$1,$2,$3,$4,$5,$6,$7)`,
    [collection, tokenId, from, to, price, orderHash, txHash],
  );
  await db.q(`update collections set volume_wei = volume_wei + $2, sales_count = sales_count + 1 where address = $1`, [collection, price]);
  const f = fee(price, config.marketFeeBps);
  if (f > 0n) await db.q(`insert into fee_ledger (source, collection, amount_wei, tx_hash) values ('trade',$1,$2,$3)`, [collection, f.toString(), txHash]);
}

/** Buy one listing, or sweep many in a single simulated transaction. */
r.post('/buy', ah(async (req, res) => {
  const hashes = [].concat(req.body?.hashes || []).slice(0, 50).map(String);
  if (!hashes.length) throw bad('Select at least one item');
  const txHash = randomHash();
  const touched = new Set();
  const out = await tx(async (db) => {
    const bought = [];
    const skipped = [];
    let total = 0n;
    for (const hash of hashes) {
      const o = await db.one(`select * from orders where hash = $1 and kind = 'listing' for update`, [hash]);
      if (!o || o.status !== 'active' || new Date(o.end_time) < new Date()) { skipped.push(hash); continue; }
      if (o.maker === req.user) { skipped.push(hash); continue; }
      const t = await db.one(`select owner from tokens where collection = $1 and token_id = $2 for update`, [o.collection, o.token_id]);
      if (!t || t.owner !== o.maker) {
        await db.q(`update orders set status = 'inactive' where hash = $1`, [hash]);
        skipped.push(hash);
        continue;
      }
      await db.q(`update orders set status = 'filled', tx_hash = $2, updated_at = now() where hash = $1`, [hash, txHash]);
      await transfer(db, { collection: o.collection, tokenId: o.token_id, from: o.maker, to: req.user, price: o.price_wei, orderHash: hash, txHash });
      bought.push({ collection: o.collection, tokenId: String(o.token_id), priceWei: o.price_wei });
      total += BigInt(o.price_wei);
      touched.add(o.collection);
    }
    return { bought, skipped, totalWei: total.toString(), txHash };
  });
  for (const c of touched) await refreshCollectionStats(c);
  if (!out.bought.length) throw bad('These items are no longer available', 'unavailable');
  res.json(out);
}));

r.post('/offer', ah(async (req, res) => {
  const col = await loadCollection(req.body?.collection);
  const price = ethToWei(req.body?.price);
  const isCollectionOffer = req.body?.tokenId === undefined || req.body?.tokenId === null || req.body?.tokenId === '';
  let tokenId = null;
  if (!isCollectionOffer) {
    tokenId = tokenIdParam(req.body.tokenId);
    const t = await one(`select owner from tokens where collection = $1 and token_id = $2`, [col.address, tokenId]);
    if (!t) throw bad('Item not found');
    if (t.owner === req.user) throw bad('You already own this item');
  }
  const hash = randomHash();
  const kind = isCollectionOffer ? 'collection_offer' : 'offer';
  await q(
    `insert into orders (hash, kind, collection, token_id, maker, price_wei, currency, end_time)
     values ($1,$2,$3,$4,$5,$6,'WETH', now() + ($7 || ' days')::interval)`,
    [hash, kind, col.address, tokenId, req.user, price, String(days(req.body?.durationDays))],
  );
  await q(`insert into activity (type, collection, token_id, from_addr, price_wei, order_hash) values ($1,$2,$3,$4,$5,$6)`, [kind === 'offer' ? 'offer' : 'collection_offer', col.address, tokenId, req.user, price, hash]);
  await refreshCollectionStats(col.address);
  res.json({ hash });
}));

r.post('/accept', ah(async (req, res) => {
  const hash = String(req.body?.hash || '');
  const txHash = randomHash();
  const out = await tx(async (db) => {
    const o = await db.one(`select * from orders where hash = $1 for update`, [hash]);
    if (!o || o.status !== 'active' || o.kind === 'listing') throw bad('This offer is no longer active');
    if (o.maker === req.user) throw bad('You cannot accept your own offer');
    const tokenId = o.kind === 'offer' ? String(o.token_id) : tokenIdParam(req.body?.tokenId);
    const t = await db.one(`select owner from tokens where collection = $1 and token_id = $2 for update`, [o.collection, tokenId]);
    if (!t || t.owner !== req.user) throw forbidden('You do not own this item');
    await db.q(`update orders set status = 'filled', tx_hash = $2, updated_at = now() where hash = $1`, [hash, txHash]);
    await transfer(db, { collection: o.collection, tokenId, from: req.user, to: o.maker, price: o.price_wei, orderHash: hash, txHash });
    return { collection: o.collection, tokenId, priceWei: o.price_wei, txHash };
  });
  await refreshCollectionStats(out.collection);
  res.json(out);
}));

/** Launchpad: create a collection + drop without deploying contracts. */
r.post('/create', ah(async (req, res) => {
  const b = req.body || {};
  const address = '0x' + randomHash().slice(2, 42);
  const phases = [];
  for (const [i, p] of (b.phases || []).slice(0, 5).entries()) {
    let allowlistId = null;
    const list = [...new Set((p.allowlist || []).map((a) => String(a).trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
    if (list.length) {
      const tree = StandardMerkleTree.of(list.map((a) => [a]), ['address']);
      const row = await one(
        `insert into allowlists (root, addresses, tree, created_by) values ($1,$2,$3,$4) returning id`,
        [tree.root, JSON.stringify(list), JSON.stringify(tree.dump()), req.user],
      );
      allowlistId = row.id;
    }
    const priceEth = String(p.priceEth ?? '0').trim() || '0';
    let priceWei;
    try { priceWei = parseEther(priceEth).toString(); } catch { throw bad(`Phase ${i + 1}: enter a valid price`); }
    phases.push({ name: p.name, start: p.start, end: p.end || null, priceWei, maxPerWallet: p.maxPerWallet, allowlistId });
  }
  await saveCollectionAndDrop({ ...b, address, phases, creator: req.user, isDemo: true, platformFeeBps: config.mintFeeBps });
  const col = await loadCollection(address);
  res.json({ collection: col });
}));

export default r;
