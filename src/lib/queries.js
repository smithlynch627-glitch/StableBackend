// Shared SQL fragments and loaders used by several routes.
import { isAddress } from 'ethers';
import { config, contractsReady } from '../config.js';
import { chainFees } from './chain.js';
import { publicSocials } from './settings.js';
import { many, one } from '../db.js';
import { notFound } from './http.js';
import { dropState } from './drops.js';

export const COLLECTION_COLS = `c.address, c.slug, c.name, c.symbol, c.description, c.image_url, c.banner_url, c.art_style,
  c.creator, c.royalty_bps, c.royalty_receiver, c.max_supply, c.total_supply, c.verified, c.is_official, c.is_external,
  c.featured, c.hidden, c.tradable, c.revealed, c.metadata_frozen, c.mint_paused, c.drop_hidden, c.contract_uri, c.twitter, c.website, c.discord, c.telegram, c.floor_wei, c.best_offer_wei, c.volume_wei, c.volume_24h_wei, c.sales_count,
  c.owners_count, c.listed_count, c.created_at`;

export const TOKEN_COLS = `t.collection, t.token_id::text as token_id, t.owner, t.name, t.image_url, t.attributes,
  t.rarity_rank, t.last_sale_wei,
  l.hash as listing_hash, l.price_wei as listing_price_wei, l.end_time as listing_end_time, l.maker as listing_maker`;

export const BEST_LISTING_JOIN = `left join lateral (
  select o.hash, o.price_wei, o.end_time, o.maker, o.created_at from orders o
  where o.collection = t.collection and o.token_id = t.token_id and o.kind = 'listing' and o.status = 'active'
  order by o.price_wei asc limit 1) l on true`;

/** Long "About" fields are only sent with a single collection, never in lists. */
const ABOUT_COLS = `c.about, c.about_image_url, c.about_items`;

export async function loadCollection(key, { includeHidden = false } = {}) {
  const k = String(key).toLowerCase();
  const col = isAddress(k)
    ? await one(`select ${COLLECTION_COLS}, ${ABOUT_COLS} from collections c where c.address = $1`, [k])
    : await one(`select ${COLLECTION_COLS}, ${ABOUT_COLS} from collections c where c.slug = $1`, [k]);
  if (!col || (col.hidden && !includeHidden)) throw notFound('Collection not found');
  return col;
}

export async function loadDrop(col) {
  if (col.drop_hidden) return null; // mint page removed by an admin
  const d = await one(`select phases, platform_fee_bps, featured from drops where collection = $1`, [col.address]);
  if (!d) return null;
  const phases = d.phases.map(({ allowlistId, merkleRoot, ...p }) => ({ ...p, hasAllowlist: Boolean(merkleRoot && !/^0x0+$/.test(merkleRoot)) }));
  // Configuration edits made after minting started (the mint page shows an alert with the details).
  const changes = await many(
    `select id, tx_hash, changes, changed_at from phase_changes where collection = $1 order by changed_at desc, id desc limit 20`,
    [col.address],
  ).catch(() => []);
  return { ...dropState(phases, col.total_supply, col.max_supply), platformFeeBps: d.platform_fee_bps, featured: d.featured, changes };
}

export async function traitCounts(collection) {
  const rows = await many(
    `select a->>'trait_type' as trait_type, a->>'value' as value, count(*)::int as count
     from tokens t, jsonb_array_elements(t.attributes) a
     where t.collection = $1 and t.owner is not null
     group by 1, 2 order by 1, 3 desc`,
    [collection],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.trait_type)) map.set(r.trait_type, []);
    map.get(r.trait_type).push({ value: r.value, count: r.count });
  }
  return [...map].map(([trait_type, values]) => ({ trait_type, values }));
}

export const ACTIVITY_SELECT = `select a.id, a.type, a.collection, a.token_id::text as token_id, a.from_addr, a.to_addr,
  a.price_wei, a.tx_hash, a.order_hash, a.created_at,
  c.name as collection_name, c.slug as collection_slug, c.art_style, c.image_url as collection_image,
  t.name as token_name, t.image_url as token_image, t.attributes as token_attributes
  from activity a
  join collections c on c.address = a.collection
  left join tokens t on t.collection = a.collection and t.token_id = a.token_id`;

export async function publicConfig() {
  const fees = contractsReady() ? await chainFees() : {};
  return {
    ready: contractsReady(),
    network: { key: config.networkKey, name: config.networkName, isTestnet: config.isTestnet },
    chainId: config.chainId,
    rpcUrl: config.publicRpcUrl,
    explorerUrl: config.explorerUrl,
    market: config.market || null,
    factory: config.factory || null,
    feeVault: config.feeVault || null,
    weth: config.weth,
    marketFeeBps: fees.marketFeeBps ?? null,
    mintFeeBps: fees.mintFeeBps ?? null,
    official: { address: config.officialCollection || null, slug: config.officialSlug },
    ipfsUploads: Boolean(config.pinataJwt),
    // The site loads IPFS images through this gateway first (e.g. your Pinata dedicated gateway), then public ones.
    ipfsGateway: /^https:\/\/[^\s]+$/.test(process.env.IPFS_GATEWAY || '') ? process.env.IPFS_GATEWAY.replace(/\/?$/, '/') : null,
    socials: await publicSocials(),
  };
}
