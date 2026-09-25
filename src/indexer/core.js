// Turns GIWA logs into marketplace state. Used by the indexer loop and by POST /api/orders/sync,
// so a user's own transaction shows up immediately.
import { Interface } from 'ethers';
import { config, ZERO_ADDRESS } from '../config.js';
import { many, one, q } from '../db.js';
import { COLLECTION_ABI, FACTORY_ABI, MARKET_ABI, collectionContract, getProvider, market as marketContract } from '../lib/chain.js';
import { refreshCollectionStats } from '../lib/stats.js';
import { assertPublicUrl, safeGet } from '../lib/safeFetch.js';

const colIface = new Interface(COLLECTION_ABI);
const marketIface = new Interface(MARKET_ABI);
const factoryIface = new Interface(FACTORY_ABI);
const T = (iface, name) => iface.getEvent(name).topicHash;
const TOPIC = {
  transfer: T(colIface, 'Transfer'),
  approvalForAll: T(colIface, 'ApprovalForAll'),
  minted: T(colIface, 'Minted'),
  phaseUpdated: T(colIface, 'PhaseUpdated'),
  phasesUpdated: T(colIface, 'PhasesUpdated'),
  revealed: T(colIface, 'Revealed'),
  baseUri: T(colIface, 'BaseURIUpdated'),
  unrevealed: T(colIface, 'UnrevealedURIUpdated'),
  batchMeta: T(colIface, 'BatchMetadataUpdate'),
  frozen: T(colIface, 'MetadataFrozen'),
  mintPaused: T(colIface, 'MintPausedSet'),
  contractUri: T(colIface, 'ContractURIUpdated'),
  supplyReduced: T(colIface, 'MaxSupplyReduced'),
};

const lc = (v) => String(v).toLowerCase();
const blockTimes = new Map();

/**
 * When the Studio saves phases it sends the transaction hash; if that transaction really changed this
 * collection's phases, the change log entry gets the hash (and block time) so the mint page can link to it.
 */
export async function phaseTxContext(address, txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return null;
  const receipt = await getProvider().getTransactionReceipt(txHash).catch(() => null);
  if (!receipt || receipt.status !== 1) return null;
  const topics = new Set([TOPIC.phasesUpdated, TOPIC.phaseUpdated]);
  const hit = receipt.logs.find((l) => lc(l.address) === lc(address) && topics.has(l.topics[0]));
  if (!hit) return null;
  return { txHash: lc(txHash), ts: await blockTime(receipt.blockNumber) };
}

/**
 * Timestamp of a block. The public RPC is load-balanced, so the node answering can be a block or two behind
 * the one that returned the log/receipt: retry briefly, and never let a missing header stop indexing.
 */
export async function blockTime(n) {
  if (!blockTimes.has(n)) {
    let b = null;
    for (let i = 0; i < 6 && !b; i++) {
      b = await getProvider().getBlock(n).catch(() => null);
      if (!b) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
    if (!b) return new Date();
    blockTimes.set(n, new Date(Number(b.timestamp) * 1000));
    if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value);
  }
  return blockTimes.get(n);
}

/** Block header time (ms). Retries, and throws if the RPC can't answer: repairs must never guess a range. */
async function headerTime(n) {
  for (let i = 0; i < 6; i++) {
    const b = await getProvider().getBlock(n).catch(() => null);
    if (b) return Number(b.timestamp) * 1000;
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  throw new Error(`block ${n} not available from the RPC`);
}

/** First block at or after a time (binary search on block headers, ~26 lookups). */
export async function blockAtTime(ms, latest) {
  let lo = 0;
  let hi = latest;
  if ((await headerTime(lo)) >= ms) return lo;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await headerTime(mid)) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const repairs = new Map(); // address → running repair
const lastRepairCheck = new Map(); // address → { t, onchain } from the last check

/**
 * Self-repair for launchpad collections: if the contract has minted more tokens than the database knows,
 * the collection's history (and the marketplace, so sales stay sales) is read again from its creation block.
 * Everything it writes is idempotent, so running it twice is harmless.
 */
export function repairCollection(address, { force = false } = {}) {
  if (repairs.has(address)) return repairs.get(address);
  const run = (async () => {
    const col = await one(`select address, created_at, is_external from collections where address = $1`, [address]);
    if (!col || col.is_external) return { repaired: false };
    const onchain = Number(await collectionContract(address).totalSupply());
    const before = (await one(`select count(*)::int as n from tokens where collection = $1`, [address])).n;
    if (!force && onchain <= before) return { repaired: false, onchain, indexed: before };
    const provider = getProvider();
    const latest = (await provider.getBlockNumber()) - 2;
    const start = await blockAtTime(new Date(col.created_at).getTime() - 10 * 60_000, latest);
    console.log(`[repair] ${address}: ${onchain} on-chain, ${before} indexed. Re-reading blocks ${start}-${latest}.`);
    for (let from = start; from <= latest; from += 2000) {
      const to = Math.min(latest, from + 1999);
      const logs = await provider.getLogs({ address: [address, config.market].filter(Boolean), fromBlock: from, toBlock: to });
      if (logs.length) await processLogs(logs);
    }
    await refreshCollectionStats(address);
    const after = (await one(`select count(*)::int as n from tokens where collection = $1`, [address])).n;
    console.log(`[repair] ${address}: ${after} tokens indexed.`);
    return { repaired: true, onchain, indexed: after };
  })().finally(() => repairs.delete(address));
  repairs.set(address, run);
  return run;
}

/**
 * Called when a collection or mint page is viewed. A collection is repaired only when the gap persists:
 * the indexed count must still be below what the contract showed at the previous check (≥ 2 min earlier),
 * so a mint that the indexer is about to pick up never triggers a needless re-read.
 */
export function maybeRepair(col) {
  if (!col?.address || col.is_external) return;
  if (col.max_supply && col.total_supply >= col.max_supply) return; // everything is already indexed
  const now = Date.now();
  const prev = lastRepairCheck.get(col.address);
  if (prev && now - prev.t < 120_000) return;
  lastRepairCheck.set(col.address, { t: now, onchain: prev?.onchain ?? null });
  (async () => {
    const onchain = Number(await collectionContract(col.address).totalSupply());
    const indexed = (await one(`select count(*)::int as n from tokens where collection = $1`, [col.address])).n;
    lastRepairCheck.set(col.address, { t: now, onchain });
    if (prev?.onchain != null && indexed < prev.onchain) await repairCollection(col.address);
  })().catch((e) => console.warn('[repair]', col.address, e.shortMessage || e.message));
}

export async function knownCollections() {
  return new Set((await many(`select address from collections`)).map((r) => r.address));
}

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'collection';

/** Reads a launchpad collection from the chain and upserts it. Keeps off-chain metadata (images, text). */
export async function syncCollectionFromChain(address, creator = null, createdAt = new Date(), ctx = null) {
  const c = collectionContract(address);
  const [name, symbol, owner, maxSupply, totalSupply, phases, royalty, revealed, frozen, paused, contractUri] = await Promise.all([
    c.name(), c.symbol(), c.owner(), c.maxSupply(), c.totalSupply(), c.getPhases(),
    c.royaltyInfo(1, 10_000).catch(() => [ZERO_ADDRESS, 0n]),
    c.revealed().catch(() => null), c.metadataFrozen().catch(() => false), c.mintPaused().catch(() => false), c.contractURI().catch(() => null),
  ]);
  const existing = await one(`select slug from collections where address = $1`, [address]);
  const slug = existing?.slug || `${slugify(name)}-${address.slice(2, 8)}`;
  await q(
    `insert into collections (address, chain_id, slug, name, symbol, creator, royalty_bps, royalty_receiver, max_supply, total_supply, created_at,
       revealed, metadata_frozen, mint_paused, contract_uri)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (address) do update set name = excluded.name, symbol = excluded.symbol, creator = coalesce(collections.creator, excluded.creator),
       royalty_bps = excluded.royalty_bps, royalty_receiver = excluded.royalty_receiver, max_supply = excluded.max_supply,
       revealed = excluded.revealed, metadata_frozen = excluded.metadata_frozen, mint_paused = excluded.mint_paused,
       contract_uri = excluded.contract_uri, is_external = false`,
    [address, config.chainId, slug, name, symbol, lc(creator || owner), Number(royalty[1]), lc(royalty[0]), Number(maxSupply), Number(totalSupply), createdAt,
      revealed, frozen, paused, contractUri || null],
  );
  await syncPhases(address, phases, ctx);
  await applyCollectionFlags();
}

const ZERO_ROOT = '0x' + '0'.repeat(64);
const gated = (root) => Boolean(root) && lc(root) !== ZERO_ROOT;

/**
 * Phase numbers always come from the contract; names and allowlist ids are kept from the creator's metadata.
 * v2 collections have stable phase ids, so names follow a phase even when a new phase is inserted above Public.
 * When the configuration changes after minting started, the change is recorded for the mint-page alert.
 */
export async function syncPhases(address, phases, ctx = null) {
  const c = collectionContract(address);
  const list = phases ?? (await c.getPhases());
  const ids = (await c.phaseIds().catch(() => null))?.map(Number) ?? null;
  const prev = await one(`select phases from drops where collection = $1`, [address]);
  const before = prev?.phases || [];
  const merged = list.map((p, i) => {
    const id = ids ? ids[i] : null;
    const old = (id != null ? before.find((b) => b.id === id) : before[i]) || {};
    const isLast = i === list.length - 1;
    const open = !gated(p.merkleRoot);
    let name = old.name || defaultPhaseName(p, i, list.length);
    if (isLast && open) name = 'Public';
    else if (/^public$/i.test(name)) name = open ? `Phase ${i + 1}` : 'Allowlist';
    return {
      id,
      name,
      start: new Date(Number(p.startTime) * 1000).toISOString(),
      end: Number(p.endTime) ? new Date(Number(p.endTime) * 1000).toISOString() : null,
      priceWei: p.price.toString(),
      maxPerWallet: Number(p.maxPerWallet) || null,
      merkleRoot: lc(p.merkleRoot),
      allowlistId: old.merkleRoot && old.merkleRoot === lc(p.merkleRoot) ? old.allowlistId ?? null : null,
    };
  });
  const fee = await c.platformFeeBps().catch(() => 1000);
  await q(
    `insert into drops (collection, phases, platform_fee_bps) values ($1,$2,$3)
     on conflict (collection) do update set phases = excluded.phases, platform_fee_bps = excluded.platform_fee_bps`,
    [address, JSON.stringify(merged), Number(fee)],
  );
  if (before.length) {
    const changes = diffPhases(before, merged);
    if (changes.length) await logConfigChange(address, before, changes, ctx);
  }
  return merged;
}

/** Human-readable list of what changed between two phase configurations. */
export function diffPhases(before, after) {
  const out = [];
  const matched = new Set();
  const byId = before.every((b) => b.id != null) && after.every((a) => a.id != null);
  after.forEach((a, i) => {
    const b = byId ? before.find((x) => x.id === a.id) : before[i];
    if (!b) {
      out.push({ type: 'added', phase: a.name, after: summary(a) });
      return;
    }
    matched.add(b);
    const label = a.name || b.name;
    const field = (key, from, to) => out.push({ type: 'changed', phase: label, field: key, from, to });
    if (b.priceWei !== a.priceWei) field('price', b.priceWei, a.priceWei);
    if (b.start !== a.start) field('start', b.start, a.start);
    if ((b.end || null) !== (a.end || null)) field('end', b.end || null, a.end || null);
    if ((b.maxPerWallet || null) !== (a.maxPerWallet || null)) field('maxPerWallet', b.maxPerWallet || null, a.maxPerWallet || null);
    if (lc(b.merkleRoot || ZERO_ROOT) !== lc(a.merkleRoot || ZERO_ROOT)) {
      field('allowlist', gated(b.merkleRoot) ? 'allowlist' : 'open', gated(a.merkleRoot) ? (gated(b.merkleRoot) ? 'updated' : 'allowlist') : 'open');
    }
  });
  before.filter((b) => !matched.has(b)).forEach((b) => out.push({ type: 'removed', phase: b.name, before: summary(b) }));
  return out;
}

function defaultPhaseName(p, i, count) {
  if (gated(p.merkleRoot)) return 'Allowlist';
  if (i === count - 1) return 'Public';
  return `Phase ${i + 1}`;
}

const summary = (p) => ({ start: p.start, end: p.end || null, priceWei: p.priceWei, maxPerWallet: p.maxPerWallet || null, allowlist: gated(p.merkleRoot) });

/** Records a mint-configuration change, but only once minting had started (first phase start passed). */
export async function logConfigChange(address, phasesBefore, changes, ctx) {
  const at = ctx?.ts || new Date();
  const firstStart = Math.min(...(phasesBefore || []).map((p) => new Date(p.start).getTime()).filter(Number.isFinite));
  if (!Number.isFinite(firstStart) || at.getTime() < firstStart) return;
  await q(
    `insert into phase_changes (collection, tx_hash, changes, changed_at) values ($1,$2,$3,$4) on conflict do nothing`,
    [address, ctx?.txHash || null, JSON.stringify(changes), at],
  );
}

/** Official GIWA COWS + verified badges come from server config, never from users. */
export async function applyCollectionFlags() {
  if (config.officialCollection) {
    await q(`update collections set is_official = false, slug = slug || '-old' where slug = $1 and address <> $2`, [config.officialSlug, config.officialCollection]);
    await q(
      `update collections set is_official = true, verified = true, slug = $2, art_style = 'cow',
         image_url = case when image_url is null or image_url like '/giwa-cows/%' then $3 else image_url end,
         banner_url = case when banner_url is null or banner_url like '/giwa-cows/%' then $4 else banner_url end
       where address = $1`,
      [config.officialCollection, config.officialSlug,
        'https://res.cloudinary.com/t1gjf2kf/image/upload/v1790232900/giwa_cow_logo.jpg',
        'https://res.cloudinary.com/t1gjf2kf/image/upload/v1790232888/giwa_cows_2500x1500.jpg'],
    );
    await q(`update drops set featured = (collection = $1)`, [config.officialCollection]);
  }
  if (config.verifiedCollections.length) {
    await q(`update collections set verified = true where address = any($1)`, [config.verifiedCollections]);
  }
}

export async function processLogs(logs) {
  const known = await knownCollections();
  const touched = new Set();
  const byTx = new Map();
  for (const log of logs) {
    if (!byTx.has(log.transactionHash)) byTx.set(log.transactionHash, []);
    byTx.get(log.transactionHash).push(log);
  }

  for (const [txHash, group] of byTx) {
    group.sort((a, b) => a.index - b.index);
    const ts = await blockTime(group[0].blockNumber);
    const sold = new Set();
    const mintPrice = new Map();

    // 1) New launchpad collections
    for (const log of group) {
      if (lc(log.address) !== config.factory) continue;
      const ev = parse(factoryIface, log);
      if (ev?.name === 'CollectionCreated') {
        const address = lc(ev.args.collection);
        await syncCollectionFromChain(address, lc(ev.args.creator), ts);
        known.add(address);
      }
    }

    // 2) Collection events: mint prices, phase edits, reveals, approval revokes
    for (const log of group) {
      const address = lc(log.address);
      if (!known.has(address)) continue;
      const topic = log.topics[0];
      if (topic === TOPIC.minted) {
        const ev = parse(colIface, log);
        const qty = Number(ev.args.quantity);
        const each = qty ? ev.args.paid / BigInt(qty) : 0n;
        for (let i = 0; i < qty; i++) mintPrice.set(`${address}:${(ev.args.firstTokenId + BigInt(i)).toString()}`, each.toString());
        if (ev.args.platformFee > 0n) {
          await q(
            `insert into fee_ledger (source, collection, amount_wei, tx_hash, log_index) values ('mint',$1,$2,$3,$4) on conflict do nothing`,
            [address, ev.args.platformFee.toString(), txHash, log.index],
          );
        }
      } else if (topic === TOPIC.phaseUpdated || topic === TOPIC.phasesUpdated) {
        await syncPhases(address, null, { ts, txHash });
      } else if ([TOPIC.revealed, TOPIC.baseUri, TOPIC.unrevealed, TOPIC.batchMeta].includes(topic)) {
        if (topic === TOPIC.revealed) await q(`update collections set revealed = true where address = $1`, [address]);
        const ids = await many(`select token_id::text as id from tokens where collection = $1 order by token_id limit 20000`, [address]);
        ids.forEach((r) => queueMetadata(address, r.id));
      } else if ([TOPIC.frozen, TOPIC.mintPaused, TOPIC.contractUri, TOPIC.supplyReduced].includes(topic)) {
        if (topic === TOPIC.mintPaused || topic === TOPIC.supplyReduced) {
          const ev = parse(colIface, log);
          const d = await one(`select phases from drops where collection = $1`, [address]);
          const change = topic === TOPIC.mintPaused
            ? { type: ev?.args.paused ? 'paused' : 'resumed' }
            : { type: 'supply', to: ev ? Number(ev.args.maxSupply) : null };
          if (d) await logConfigChange(address, d.phases, [change], { ts, txHash: `${txHash}:${log.index}` }).catch(() => {});
        }
        await syncCollectionFromChain(address).catch((e) => console.warn('[sync]', address, e.message));
      } else if (topic === TOPIC.approvalForAll) {
        const ev = parse(colIface, log);
        if (ev && lc(ev.args.operator) === config.market && !ev.args.approved) {
          await q(
            `update orders set status = 'inactive', updated_at = now() where collection = $1 and maker = $2 and kind = 'listing' and status = 'active'`,
            [address, lc(ev.args.owner)],
          );
          touched.add(address);
        }
      }
    }

    // 3) Marketplace
    for (const log of group) {
      if (lc(log.address) !== config.market) continue;
      const ev = parse(marketIface, log);
      if (!ev) continue;
      if (ev.name === 'OrderFilled') {
        const c = await onOrderFilled(ev, log, txHash, ts, known);
        if (c) {
          sold.add(`${c}:${ev.args.tokenId.toString()}`);
          touched.add(c);
        }
      } else if (ev.name === 'OrderCancelled') {
        const c = await onOrderCancelled(lc(ev.args.orderHash), txHash, log.index, ts);
        if (c) touched.add(c);
      } else if (ev.name === 'CollectionApprovalSet' || ev.name === 'CollectionBlockedSet') {
        const c = lc(ev.args.collection);
        const tradable = await marketContract().isTradable(c).catch(() => false);
        await q(`update collections set tradable = $2 where address = $1`, [c, tradable]);
        if (!tradable) {
          await q(`update orders set status = 'inactive', updated_at = now() where collection = $1 and status = 'active'`, [c]);
          touched.add(c);
        }
      } else if (ev.name === 'CounterIncremented') {
        const rows = await many(
          `update orders set status = 'cancelled', updated_at = now()
           where maker = $1 and counter < $2 and status in ('active','inactive') returning collection`,
          [lc(ev.args.maker), ev.args.newCounter.toString()],
        );
        rows.forEach((r) => touched.add(r.collection));
      }
    }

    // 4) Transfers (mints, sends, ownership after sales)
    for (const log of group) {
      const address = lc(log.address);
      if (!known.has(address) || log.topics[0] !== TOPIC.transfer || log.topics.length !== 4) continue;
      const ev = parse(colIface, log);
      if (!ev) continue;
      const tokenId = ev.args.tokenId.toString();
      await onTransfer(address, lc(ev.args.from), lc(ev.args.to), tokenId, txHash, log.index, ts, sold, mintPrice.get(`${address}:${tokenId}`));
      touched.add(address);
    }
  }

  for (const c of touched) await refreshCollectionStats(c);
  return { collections: [...touched] };
}

function parse(iface, log) {
  try {
    return iface.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return null;
  }
}

async function onOrderFilled(ev, log, txHash, ts, known) {
  const collection = lc(ev.args.collection);
  if (!known.has(collection)) return null;
  const hash = lc(ev.args.orderHash);
  const maker = lc(ev.args.maker);
  const taker = lc(ev.args.taker);
  const isListing = Number(ev.args.side) === 0;
  const seller = isListing ? maker : taker;
  const buyer = isListing ? taker : maker;
  const tokenId = ev.args.tokenId.toString();
  const price = ev.args.price.toString();

  await q(`update orders set status = 'filled', tx_hash = $2, updated_at = now() where hash = $1`, [hash, txHash]);
  const inserted = await one(
    `insert into activity (chain_id, type, collection, token_id, from_addr, to_addr, price_wei, tx_hash, order_hash, log_index, created_at)
     values ($1,'sale',$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning id`,
    [config.chainId, collection, tokenId, seller, buyer, price, txHash, hash, log.index, ts],
  );
  if (inserted) {
    await q(`update tokens set last_sale_wei = $3 where collection = $1 and token_id = $2`, [collection, tokenId, price]);
    await q(`update collections set volume_wei = volume_wei + $2, sales_count = sales_count + 1 where address = $1`, [collection, price]);
    if (ev.args.fee > 0n) {
      await q(
        `insert into fee_ledger (source, collection, amount_wei, tx_hash, log_index) values ('trade',$1,$2,$3,$4) on conflict do nothing`,
        [collection, ev.args.fee.toString(), txHash, log.index],
      );
    }
  }
  return collection;
}

async function onOrderCancelled(hash, txHash, logIndex, ts) {
  const o = await one(`update orders set status = 'cancelled', tx_hash = $2, updated_at = now() where hash = $1 returning *`, [hash, txHash]);
  if (!o) return null;
  await q(
    `insert into activity (chain_id, type, collection, token_id, from_addr, price_wei, tx_hash, order_hash, log_index, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
    [config.chainId, o.kind === 'listing' ? 'delist' : 'offer_cancel', o.collection, o.token_id, o.maker, o.price_wei, txHash, hash, logIndex, ts],
  );
  return o.collection;
}

async function onTransfer(collection, from, to, tokenId, txHash, logIndex, ts, sold, mintPrice) {
  const col = await one(`select name from collections where address = $1`, [collection]);
  await q(
    `insert into tokens (collection, token_id, owner, name, minted_at) values ($1,$2,$3,$4,$5)
     on conflict (collection, token_id) do update set owner = excluded.owner`,
    [collection, tokenId, to, `${col?.name || 'Token'} #${tokenId}`, ts],
  );
  const isMint = from === ZERO_ADDRESS;
  if (isMint || !sold.has(`${collection}:${tokenId}`)) {
    await q(
      `insert into activity (chain_id, type, collection, token_id, from_addr, to_addr, price_wei, tx_hash, log_index, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
      [config.chainId, isMint ? 'mint' : 'transfer', collection, tokenId, from, to, isMint ? mintPrice ?? null : null, txHash, logIndex, ts],
    );
  }
  // A listing is only valid while its maker owns the NFT.
  await q(
    `update orders set status = 'inactive', updated_at = now()
     where collection = $1 and token_id = $2 and kind = 'listing' and status = 'active' and maker <> $3`,
    [collection, tokenId, to],
  );
  if (isMint) {
    const t = await one(`select image_url from tokens where collection = $1 and token_id = $2`, [collection, tokenId]);
    if (!t?.image_url) queueMetadata(collection, tokenId);
  }
}

// ── Metadata (tokenURI → JSON) ────────────────────────────────────────────────
const queue = [];
const pending = new Set();
let running = false;
const touchedForRarity = new Set();

export function queueMetadata(collection, tokenId, attempt = 0) {
  const key = `${collection}:${tokenId}`;
  if (attempt === 0 && pending.has(key)) return; // already queued or waiting for a retry
  pending.add(key);
  queue.push([collection, tokenId, attempt]);
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const batch = queue.splice(0, 4); // public IPFS gateways rate-limit bursts
    await Promise.all(
      batch.map(async ([c, id, attempt]) => {
        const key = `${c}:${id}`;
        try {
          await fetchMetadata(c, id);
          touchedForRarity.add(c);
          pending.delete(key);
        } catch (e) {
          // New IPFS uploads take a while to spread and gateways rate-limit: retry with backoff (up to ~30 min).
          if (attempt < 6) setTimeout(() => queueMetadata(c, id, attempt + 1), Math.min(15_000 * 2 ** attempt, 600_000)).unref?.();
          else {
            pending.delete(key);
            console.warn('[metadata]', c, id, e.message);
          }
        }
      }),
    );
  }
  running = false;
  for (const c of [...touchedForRarity]) {
    touchedForRarity.delete(c);
    await computeRarity(c).catch((e) => console.warn('[rarity]', c, e.message));
  }
}

/** Safety net: tokens still without metadata (e.g. every gateway was busy) are queued again, a few at a time. */
export async function backfillMetadata(limit = 40) {
  const rows = await many(
    `select collection, token_id::text as id from tokens
     where image_url is null and owner is not null and minted_at > now() - interval '30 days'
     order by minted_at desc limit $1`,
    [limit],
  );
  rows.forEach((r) => queueMetadata(r.collection, r.id));
  return rows.length;
}

/** Gateways tried in order. IPFS_GATEWAY (e.g. your dedicated Pinata gateway) goes first. */
const GATEWAYS = [process.env.IPFS_GATEWAY, 'https://ipfs.io/ipfs/', 'https://w3s.link/ipfs/', 'https://dweb.link/ipfs/', 'https://4everland.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/']
  .filter(Boolean)
  .map((g) => (g.endsWith('/') ? g : `${g}/`));
const coolDown = new Map(); // gateway → time it may be used again (after HTTP 429)
const gatewayOrder = () => {
  const now = Date.now();
  const ok = GATEWAYS.filter((g) => !(coolDown.get(g) > now));
  return ok.length ? ok : GATEWAYS;
};

const ipfsPath = (uri) => fixIpfsPath(uri.slice(7).replace(/^ipfs\//, ''));
/**
 * A "bafkrei…" CID is a single raw file: it can never have a file name after it. Metadata made by uploading
 * each image on its own and then writing "ipfs://bafkrei…/1.jpg" points nowhere, so the name is dropped.
 */
const RAW_CID_WITH_PATH = /^(bafkrei[a-z2-7]{20,})\/[^?#]*/i;
const fixIpfsPath = (path) => path.replace(RAW_CID_WITH_PATH, '$1');
export const hasRawCidPath = (uri) => typeof uri === 'string' && /(^ipfs:\/\/|\/ipfs\/)(ipfs\/)?bafkrei[a-z2-7]{20,}\/[^?#]+/i.test(uri);
export const ipfsToHttp = (uri, gateway = GATEWAYS[0]) => {
  if (!uri || typeof uri !== 'string') return uri;
  if (uri.startsWith('ipfs://')) return `${gateway}${ipfsPath(uri)}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice(5)}`;
  return uri.replace(/(\/ipfs\/)(bafkrei[a-z2-7]{20,})\/[^?#]*/i, '$1$2');
};

/** SQL that repairs image links already saved with a file name after a single-file CID. */
export async function repairRawCidImages() {
  const r = await q(
    `update tokens set image_url = regexp_replace(image_url, '(/ipfs/bafkrei[a-z2-7]+)/[^?#]*', '\\1', 'i')
     where image_url ~* '/ipfs/bafkrei[a-z2-7]+/[^?#]+'`,
  );
  if (r.rowCount) console.log(`[metadata] repaired ${r.rowCount} image links (file name after a single-file CID)`);
}

/** Checks that an image link really loads (first bytes only), trying every gateway for ipfs:// links. */
export async function probeImage(uri, { timeout = 8_000 } = {}) {
  const first = await probeOnce(uri, timeout);
  if (first.ok) return first;
  // "ipfs://<cid>/1.jpg" where <cid> is really a single file: the bare CID is what loads.
  const bare = typeof uri === 'string' && uri.match(/^ipfs:\/\/(?:ipfs\/)?([a-z0-9]{40,})\/[^?#]+/i);
  if (bare) {
    const second = await probeOnce(`ipfs://${bare[1]}`, timeout);
    if (second.ok) return { ...second, bareCid: true };
  }
  return first;
}

async function probeOnce(uri, timeout) {
  if (!uri || typeof uri !== 'string') return { ok: false, error: 'no image' };
  if (uri.startsWith('data:image/')) return { ok: true };
  const trusted = uri.startsWith('ipfs://') || uri.startsWith('ar://');
  const urls = uri.startsWith('ipfs://') ? GATEWAYS.map((g) => ipfsToHttp(uri, g)) : [ipfsToHttp(uri)];
  let last = 'not reachable';
  for (let url of urls) {
    try {
      // User-supplied web links are checked against private/internal addresses first (SSRF protection).
      const get = async (u) => {
        if (!trusted) await assertPublicUrl(u);
        return fetch(u, { signal: AbortSignal.timeout(timeout), redirect: trusted ? 'follow' : 'manual', headers: { range: 'bytes=0-2047' } });
      };
      let res = await get(url);
      if (!trusted && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).toString();
        res = await get(url);
      }
      const type = res.headers.get('content-type') || '';
      await res.body?.cancel().catch(() => {});
      if (!res.ok) { last = `HTTP ${res.status}`; continue; }
      if (/^text\/html/i.test(type)) { last = 'the link opens a folder or web page, not an image'; continue; }
      return { ok: true, url };
    } catch (e) {
      last = e.name === 'TimeoutError' ? 'timed out' : e.message;
    }
  }
  return { ok: false, error: last };
}

/** Fetches JSON from ipfs:// (all gateways), ar:// or https://, with a timeout and a size cap. */
export async function fetchJsonUri(uri, { timeout = 12_000, maxBytes = 1_000_000 } = {}) {
  if (uri.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  if (uri.startsWith('data:application/json')) return JSON.parse(decodeURIComponent(uri.split(',').slice(1).join(',')));
  const gws = uri.startsWith('ipfs://') ? gatewayOrder() : [null];
  let last;
  for (const g of gws) {
    const url = g ? ipfsToHttp(uri, g) : ipfsToHttp(uri);
    try {
      if (!g && !url.startsWith('https://arweave.net/')) {
        // A creator-controlled web link: fetched with SSRF protection (public https hosts only, safe redirects).
        const { buf } = await safeGet(url, { timeout, maxBytes, accept: 'application/json' });
        return JSON.parse(buf.toString('utf8'));
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
      if (res.status === 429 && g) coolDown.set(g, Date.now() + 60_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('metadata file too large');
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('not reachable');
}

/** Keeps short token numbers visible ("Unrevealed #12"); long ids (e.g. name NFTs) are left out. */
function displayName(name, tokenId) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim().slice(0, 110);
  const id = String(tokenId);
  if (id.length > 12) return n;
  return new RegExp(`(^|\\D)${id}(\\D|$)`).test(n) ? n : `${n} #${id}`;
}

/**
 * The picture for a token, in any format a browser can show: "image" (PNG, JPG, GIF, WebP, AVIF, SVG, BMP,
 * or a video file), "image_url", on-chain SVG in "image_data", or the "animation_url" when there is no image.
 */
export function metadataMedia(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const pick = [meta.image, meta.image_url, meta.imageUrl].find((v) => typeof v === 'string' && v.trim());
  if (pick) return ipfsToHttp(pick.trim());
  if (typeof meta.image_data === 'string' && meta.image_data.includes('<svg')) {
    return `data:image/svg+xml;base64,${Buffer.from(meta.image_data).toString('base64')}`;
  }
  if (typeof meta.animation_url === 'string' && meta.animation_url.trim()) return ipfsToHttp(meta.animation_url.trim());
  return null;
}

export async function fetchMetadata(collection, tokenId) {
  const uri = await collectionContract(collection).tokenURI(tokenId);
  const meta = await fetchJsonUri(uri);
  await q(
    `update tokens set name = coalesce($3, name), image_url = $4, attributes = $5 where collection = $1 and token_id = $2`,
    [collection, tokenId, displayName(meta.name, tokenId), metadataMedia(meta),
      JSON.stringify(Array.isArray(meta.attributes) ? meta.attributes.filter((a) => a && a.trait_type !== undefined).slice(0, 50) : [])],
  );
}

/**
 * Rarity rank per collection: each trait adds ln(total / tokens-with-that-trait), rarest total score = rank 1.
 * Tokens without attributes (e.g. before reveal) get no rank.
 */
export async function computeRarity(collection) {
  await q(
    `with toks as (select token_id, attributes from tokens where collection = $1 and jsonb_typeof(attributes) = 'array' and jsonb_array_length(attributes) > 0),
          total as (select count(*)::float as n from toks),
          traits as (select t.token_id, a->>'trait_type' as tt, a->>'value' as v from toks t, jsonb_array_elements(t.attributes) a),
          freq as (select tt, v, count(*)::float as c from traits group by tt, v),
          scores as (select tr.token_id, sum(ln((select n from total) / f.c)) as s from traits tr join freq f using (tt, v) group by tr.token_id),
          ranked as (select token_id, rank() over (order by s desc) as r from scores)
     update tokens t set rarity_rank = ranked.r from ranked where t.collection = $1 and t.token_id = ranked.token_id`,
    [collection],
  );
  await q(`update tokens set rarity_rank = null where collection = $1 and (jsonb_typeof(attributes) <> 'array' or jsonb_array_length(attributes) = 0)`, [collection]);
}
