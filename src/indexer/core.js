// Turns GIWA logs into marketplace state. Used by the indexer loop and by POST /api/orders/sync,
// so a user's own transaction shows up immediately.
import { Interface } from 'ethers';
import { config, ZERO_ADDRESS } from '../config.js';
import { many, one, q } from '../db.js';
import { COLLECTION_ABI, FACTORY_ABI, MARKET_ABI, collectionContract, getProvider, market as marketContract } from '../lib/chain.js';
import { refreshCollectionStats } from '../lib/stats.js';

const colIface = new Interface(COLLECTION_ABI);
const marketIface = new Interface(MARKET_ABI);
const factoryIface = new Interface(FACTORY_ABI);
const T = (iface, name) => iface.getEvent(name).topicHash;
const TOPIC = {
  transfer: T(colIface, 'Transfer'),
  approvalForAll: T(colIface, 'ApprovalForAll'),
  minted: T(colIface, 'Minted'),
  phaseUpdated: T(colIface, 'PhaseUpdated'),
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

async function blockTime(n) {
  if (!blockTimes.has(n)) {
    const b = await getProvider().getBlock(n);
    blockTimes.set(n, new Date(Number(b.timestamp) * 1000));
    if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value);
  }
  return blockTimes.get(n);
}

export async function knownCollections() {
  return new Set((await many(`select address from collections`)).map((r) => r.address));
}

export const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'collection';

/** Reads a launchpad collection from the chain and upserts it. Keeps off-chain metadata (images, text). */
export async function syncCollectionFromChain(address, creator = null, createdAt = new Date()) {
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
  await syncPhases(address, phases);
  await applyCollectionFlags();
}

/** Phase numbers always come from the contract; names and allowlist ids are kept from the creator's metadata. */
export async function syncPhases(address, phases) {
  const list = phases ?? (await collectionContract(address).getPhases());
  const prev = await one(`select phases from drops where collection = $1`, [address]);
  const merged = list.map((p, i) => {
    const old = prev?.phases?.[i] || {};
    return {
      name: old.name || defaultPhaseName(p, i, list.length),
      start: new Date(Number(p.startTime) * 1000).toISOString(),
      end: Number(p.endTime) ? new Date(Number(p.endTime) * 1000).toISOString() : null,
      priceWei: p.price.toString(),
      maxPerWallet: Number(p.maxPerWallet) || null,
      merkleRoot: lc(p.merkleRoot),
      allowlistId: old.merkleRoot && old.merkleRoot === lc(p.merkleRoot) ? old.allowlistId ?? null : null,
    };
  });
  const fee = await collectionContract(address).platformFeeBps().catch(() => 1000);
  await q(
    `insert into drops (collection, phases, platform_fee_bps) values ($1,$2,$3)
     on conflict (collection) do update set phases = excluded.phases, platform_fee_bps = excluded.platform_fee_bps`,
    [address, JSON.stringify(merged), Number(fee)],
  );
}

function defaultPhaseName(p, i, count) {
  if (p.merkleRoot !== '0x' + '0'.repeat(64)) return 'Allowlist';
  if (i === count - 1) return 'Public';
  return `Phase ${i + 1}`;
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
          await q(`insert into fee_ledger (source, collection, amount_wei, tx_hash) values ('mint',$1,$2,$3)`, [address, ev.args.platformFee.toString(), txHash]);
        }
      } else if (topic === TOPIC.phaseUpdated) {
        await syncPhases(address);
      } else if ([TOPIC.revealed, TOPIC.baseUri, TOPIC.unrevealed, TOPIC.batchMeta].includes(topic)) {
        if (topic === TOPIC.revealed) await q(`update collections set revealed = true where address = $1`, [address]);
        const ids = await many(`select token_id::text as id from tokens where collection = $1 order by token_id limit 20000`, [address]);
        ids.forEach((r) => queueMetadata(address, r.id));
      } else if ([TOPIC.frozen, TOPIC.mintPaused, TOPIC.contractUri, TOPIC.supplyReduced].includes(topic)) {
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
      await q(`insert into fee_ledger (source, collection, amount_wei, tx_hash) values ('trade',$1,$2,$3)`, [collection, ev.args.fee.toString(), txHash]);
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
  if (isMint) queueMetadata(collection, tokenId);
}

// ── Metadata (tokenURI → JSON) ────────────────────────────────────────────────
const queue = [];
let running = false;
const touchedForRarity = new Set();

export function queueMetadata(collection, tokenId, attempt = 0) {
  queue.push([collection, tokenId, attempt]);
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const batch = queue.splice(0, 8);
    await Promise.all(
      batch.map(async ([c, id, attempt]) => {
        try {
          await fetchMetadata(c, id);
          touchedForRarity.add(c);
        } catch (e) {
          // IPFS content can take a while to propagate after an upload: retry with backoff.
          if (attempt < 4) setTimeout(() => queueMetadata(c, id, attempt + 1), 15_000 * 2 ** attempt).unref?.();
          else console.warn('[metadata]', c, id, e.message);
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

/** Gateways tried in order. IPFS_GATEWAY (e.g. your dedicated Pinata gateway) goes first. */
const GATEWAYS = [process.env.IPFS_GATEWAY, 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/']
  .filter(Boolean)
  .map((g) => (g.endsWith('/') ? g : `${g}/`));

const ipfsPath = (uri) => uri.slice(7).replace(/^ipfs\//, '');
export const ipfsToHttp = (uri, gateway = GATEWAYS[0]) => {
  if (!uri || typeof uri !== 'string') return uri;
  if (uri.startsWith('ipfs://')) return `${gateway}${ipfsPath(uri)}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice(5)}`;
  return uri;
};

/** Fetches JSON from ipfs:// (all gateways), ar:// or https://, with a timeout and a size cap. */
export async function fetchJsonUri(uri, { timeout = 12_000, maxBytes = 1_000_000 } = {}) {
  if (uri.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
  if (uri.startsWith('data:application/json')) return JSON.parse(decodeURIComponent(uri.split(',').slice(1).join(',')));
  const urls = uri.startsWith('ipfs://') ? GATEWAYS.map((g) => ipfsToHttp(uri, g)) : [ipfsToHttp(uri)];
  let last;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
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

export async function fetchMetadata(collection, tokenId) {
  const uri = await collectionContract(collection).tokenURI(tokenId);
  const meta = await fetchJsonUri(uri);
  await q(
    `update tokens set name = coalesce($3, name), image_url = $4, attributes = $5 where collection = $1 and token_id = $2`,
    [collection, tokenId, displayName(meta.name, tokenId), ipfsToHttp(meta.image || meta.image_url || null),
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
