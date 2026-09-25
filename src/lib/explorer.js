// Import collections that already exist on the network (deployed outside the launchpad) using the
// Blockscout API v2 of the network's explorer (GIWA uses Blockscout).
import { Contract } from 'ethers';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { bad } from './http.js';
import { ERC721_ABI_MIN, getProvider, isLaunchpadCollection, market } from './chain.js';
import { refreshCollectionStats } from './stats.js';
import { slugify, syncCollectionFromChain, applyCollectionFlags, computeRarity } from '../indexer/core.js';

const lc = (v) => String(v || '').toLowerCase();

/**
 * Fetch JSON from the explorer. Large integers (token ids, paging cursors) are kept as exact strings:
 * JSON.parse would round anything above 2^53, and sending a rounded cursor back makes Blockscout answer 422.
 */
async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) {
    let detail = '';
    try { detail = JSON.parse(text).message || JSON.stringify(JSON.parse(text).errors || '') ; } catch { detail = text.slice(0, 160); }
    throw bad(`Explorer API responded ${r.status}${detail ? `: ${detail}` : ''} (${new URL(url).pathname})`);
  }
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

const pageQuery = (url, params) => {
  if (params) for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && typeof v !== 'object') url.searchParams.set(k, String(v));
  return url;
};

function base() {
  if (!config.explorerApiUrl) throw bad('Set the explorer API URL for this network in the admin panel');
  return config.explorerApiUrl.replace(/\/$/, '');
}

/** One page of ERC-721 contracts on the network, most holders first. */
export async function discover(pageParams = null) {
  const url = new URL(`${base()}/tokens`);
  url.searchParams.set('type', 'ERC-721');
  pageQuery(url, pageParams);
  const j = await getJson(url);
  const items = (j.items || []).map((t) => ({
    address: lc(t.address_hash || t.address),
    name: t.name || 'Unnamed',
    symbol: t.symbol || '',
    holders: Number(t.holders_count ?? t.holders ?? 0),
    totalSupply: t.total_supply ?? null,
    icon: t.icon_url || null,
  }));
  const known = new Set();
  for (const it of items) {
    const row = await one(`select address from collections where address = $1`, [it.address]);
    if (row) known.add(it.address);
  }
  return { items: items.map((it) => ({ ...it, imported: known.has(it.address) })), next: j.next_page_params || null };
}

/** Adds (or refreshes) a collection and its current owners/metadata. New transfers are then followed by the indexer. */
export async function importCollection(address, maxTokens = 5000) {
  const a = lc(address);
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw bad('Invalid contract address');
  const provider = getProvider();
  if ((await provider.getCode(a)) === '0x') throw bad('No contract at this address on the active network');

  const fromLaunchpad = await isLaunchpadCollection(a);
  if (fromLaunchpad) {
    await syncCollectionFromChain(a);
  } else {
    const c = new Contract(a, ERC721_ABI_MIN, provider);
    const isNft = await c.supportsInterface('0x80ac58cd').catch(() => false);
    if (!isNft) throw bad('This contract is not an ERC-721 NFT collection');
    const [name, symbol, owner, supply] = await Promise.all([
      c.name().catch(() => 'Unnamed collection'), c.symbol().catch(() => ''), c.owner().catch(() => null), c.totalSupply().catch(() => null),
    ]);
    const royalty = await c.royaltyInfo(1, 10_000).catch(() => null);
    const existing = await one(`select slug from collections where address = $1`, [a]);
    await q(
      `insert into collections (address, slug, name, symbol, creator, royalty_bps, royalty_receiver, max_supply, total_supply, is_external)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       on conflict (address) do update set name = excluded.name, symbol = excluded.symbol, royalty_bps = excluded.royalty_bps`,
      [a, existing?.slug || `${slugify(name)}-${a.slice(2, 8)}`, String(name).slice(0, 80), String(symbol).slice(0, 20), owner ? lc(owner) : null,
        royalty ? Number(royalty[1]) : 0, royalty ? lc(royalty[0]) : null, supply !== null ? Number(supply) : null, supply !== null ? Number(supply) : 0],
    );
  }
  const tradable = config.market ? await market().isTradable(a).catch(() => false) : false;
  await q(`update collections set tradable = $2 where address = $1`, [a, tradable]);

  // Current tokens from the explorer (owners + metadata), paged. A failing page stops paging but keeps
  // everything imported so far; the indexer then follows every new transfer on-chain.
  let next = null;
  let imported = 0;
  let warning = null;
  do {
    const url = pageQuery(new URL(`${base()}/tokens/${a}/instances`), next);
    let j;
    try {
      j = await getJson(url);
    } catch (e) {
      warning = imported
        ? `Stopped after ${imported} items: ${e.message}`
        : `Collection added, but its items could not be read from the explorer yet (${e.message}). New transfers will still appear.`;
      break;
    }
    for (const it of j.items || []) {
      const id = String(it.id ?? it.token_id ?? '');
      if (!/^\d+$/.test(id)) continue;
      let owner = lc(it.owner?.hash || it.owner || '');
      if (!/^0x[0-9a-f]{40}$/.test(owner)) {
        owner = lc(await new Contract(a, ERC721_ABI_MIN, provider).ownerOf(id).catch(() => ''));
        if (!owner) continue;
      }
      const meta = it.metadata || {};
      await q(
        `insert into tokens (collection, token_id, owner, name, image_url, attributes) values ($1,$2,$3,$4,$5,$6)
         on conflict (collection, token_id) do update set owner = excluded.owner,
           name = coalesce(excluded.name, tokens.name), image_url = coalesce(excluded.image_url, tokens.image_url),
           attributes = case when jsonb_array_length(excluded.attributes) > 0 then excluded.attributes else tokens.attributes end`,
        [a, id, owner, typeof meta.name === 'string' ? meta.name.slice(0, 120) : null, it.image_url || meta.image || null,
          JSON.stringify(Array.isArray(meta.attributes) ? meta.attributes.slice(0, 50) : [])],
      );
      imported++;
    }
    next = j.next_page_params || null;
  } while (next && imported < maxTokens);

  await applyCollectionFlags();
  await computeRarity(a).catch(() => {});
  await refreshCollectionStats(a);
  return { address: a, tokens: imported, tradable, fromLaunchpad, warning };
}
