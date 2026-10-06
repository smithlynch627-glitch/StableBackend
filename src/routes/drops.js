import { Router } from 'express';
import { connectedXLink, xReady } from './x.js';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { config } from '../config.js';
import { many, one, q } from '../db.js';
import { addrParam, ah, bad, clampInt, forbidden } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { COLLECTION_COLS, loadCollection, loadDrop } from '../lib/queries.js';
import { dropState } from '../lib/drops.js';
import { collectionContract, isLaunchpadCollection } from '../lib/chain.js';
import { maybeRepair, phaseTxContext, syncCollectionFromChain } from '../indexer/core.js';
import { cleanGallery, cleanMediaLink, galleryReady } from '../lib/collectionMedia.js';

const r = Router();
const publicPhases = (phases) => phases.map(({ allowlistId, merkleRoot, ...p }) => ({ ...p, hasAllowlist: Boolean(merkleRoot && !/^0x0+$/.test(merkleRoot)) }));

r.get('/', ah(async (req, res) => {
  const rows = await many(
    `select ${COLLECTION_COLS}, d.phases, d.platform_fee_bps, d.featured
     from drops d join collections c on c.address = d.collection where not c.hidden and not c.drop_hidden
     order by d.featured desc, c.featured desc, c.created_at desc limit 200`,
  );
  const order = { live: 0, upcoming: 1, sold_out: 2, ended: 3 };
  let drops = rows.map(({ phases, platform_fee_bps, featured, ...collection }) => ({
    collection, featured, platformFeeBps: platform_fee_bps,
    ...dropState(publicPhases(phases), collection.total_supply, collection.max_supply),
  }));
  const status = String(req.query.status || '');
  if (status) drops = drops.filter((d) => (status === 'ended' ? ['ended', 'sold_out'].includes(d.status) : d.status === status));
  drops.sort((a, b) => order[a.status] - order[b.status] || Number(b.featured) - Number(a.featured));
  res.json({ drops: drops.slice(0, clampInt(req.query.limit, 1, 100, 50)) });
}));

r.get('/:key', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  maybeRepair(col);
  const drop = await loadDrop(col);
  if (!drop) throw bad('This collection has no launchpad drop', 'no_drop');
  res.json({ collection: col, drop });
}));

/** Allowlist eligibility + Merkle proof per phase. Mint counts and prices are read from the contract by the UI. */
r.get('/:key/eligibility/:wallet', ah(async (req, res) => {
  const col = await loadCollection(req.params.key);
  const wallet = addrParam(req.params.wallet, 'wallet');
  const d = await one(`select phases from drops where collection = $1`, [col.address]);
  if (!d) throw bad('No drop');
  const out = [];
  for (const [index, p] of d.phases.entries()) {
    const gated = p.merkleRoot && !/^0x0+$/.test(p.merkleRoot);
    let eligible = !gated;
    let proof = [];
    if (gated && p.allowlistId) {
      const al = await one(`select tree from allowlists where id = $1`, [p.allowlistId]);
      if (al) {
        const tree = StandardMerkleTree.load(al.tree);
        if (tree.root.toLowerCase() === p.merkleRoot) {
          for (const [i, v] of tree.entries()) {
            if (String(v[0]).toLowerCase() === wallet) { eligible = true; proof = tree.getProof(i); break; }
          }
        }
      }
    }
    out.push({ index, eligible, proof, hasAllowlist: gated });
  }
  res.json({ phases: out });
}));

/** Creates an allowlist and returns its Merkle root (StandardMerkleTree, leaf = address). */
r.post('/allowlists', requireAuth, ah(async (req, res) => {
  const list = [...new Set((req.body?.addresses || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  if (!list.length) throw bad('Add at least one wallet address');
  if (list.length > 20000) throw bad('Allowlists are limited to 20,000 wallets');
  const invalid = list.find((a) => !/^0x[0-9a-f]{40}$/.test(a));
  if (invalid) throw bad(`Invalid address in allowlist: ${invalid}`);
  const tree = StandardMerkleTree.of(list.map((a) => [a]), ['address']);
  const row = await one(
    `insert into allowlists (root, addresses, tree, created_by) values ($1,$2,$3,$4) returning id, root`,
    [tree.root.toLowerCase(), JSON.stringify(list), JSON.stringify(tree.dump()), req.user],
  );
  res.json({ id: row.id, root: row.root, count: list.length });
}));

/**
 * Registers display details for a launchpad collection (text, images, links, phase names, allowlists).
 * Only the on-chain owner can do this. Prices, times, limits and roots always come from the contract.
 * Images: logo (imageUrl), banner (bannerUrl) and up to three extra images (gallery) for the mint page.
 * About tab: story (about), its picture (aboutImageUrl) and up to 12 detail rows (aboutItems).
 */
r.post('/', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const address = addrParam(b.collection, 'collection');
  if (!(await isLaunchpadCollection(address))) throw bad('This contract was not created by the launchpad');
  const owner = String(await collectionContract(address).owner()).toLowerCase();
  if (owner !== req.user) throw forbidden('Only the collection owner can edit this drop');

  await syncCollectionFromChain(address, owner, undefined, await phaseTxContext(address, b.txHash));
  // The X link is never typed: it is the owner's connected X account (Create / Studio → Connect X).
  if ('twitter' in b && xReady()) {
    b.twitter = await connectedXLink(req.user);
    if (!b.twitter) throw bad('Connect your X account first (Create → Details → Connect X).');
  }
  // Only the fields that were sent are changed (the Studio sends partial updates).
  const fields = { description: 'description', imageUrl: 'image_url', bannerUrl: 'banner_url', twitter: 'twitter', website: 'website', discord: 'discord', telegram: 'telegram' };
  const sets = [];
  const params = [address];
  for (const [k, col] of Object.entries(fields)) {
    if (!(k in b)) continue;
    if (k === 'imageUrl' && !String(b.imageUrl || '').trim()) continue; // a collection always keeps a logo
    params.push(k === 'description' ? String(b.description || '').slice(0, 2000) : k === 'imageUrl' || k === 'bannerUrl' ? safeImage(b[k]) : safeLink(b[k]));
    sets.push(`${col} = $${params.length}`);
  }
  const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  // Extra images need db/06_gallery.sql. Without it the rest is still saved (a new collection must never lose
  // its details over this) and the reply says the extra images were skipped.
  const warnings = [];
  if ('gallery' in b) {
    const gallery = cleanGallery(b.gallery);
    if (await galleryReady()) set('gallery', JSON.stringify(gallery));
    else if (gallery.length) warnings.push('gallery_not_ready');
  }
  if ('about' in b) set('about', b.about ? String(b.about).slice(0, 8000) : null);
  if ('aboutImageUrl' in b) set('about_image_url', cleanMediaLink(b.aboutImageUrl, 'About image'));
  if ('aboutItems' in b) {
    if (!Array.isArray(b.aboutItems) || b.aboutItems.length > 12) throw bad('About details: up to 12 rows');
    const items = b.aboutItems
      .map((x) => ({ label: String(x?.label || '').trim().slice(0, 40), value: String(x?.value || '').trim().slice(0, 300) }))
      .filter((x) => x.label && x.value);
    set('about_items', JSON.stringify(items));
  }
  if (sets.length) await q(`update collections set ${sets.join(', ')} where address = $1`, params);

  const d = await one(`select phases from drops where collection = $1`, [address]);
  const phases = d.phases;
  const open = (p) => !p.merkleRoot || /^0x0+$/.test(p.merkleRoot);
  for (const [i, meta] of (b.phases || []).slice(0, phases.length).entries()) {
    if (meta?.name) phases[i].name = String(meta.name).trim().slice(0, 32) || phases[i].name;
    // "Public" is reserved for the last phase, which is open to everyone.
    if (/^public$/i.test(phases[i].name) && !(i === phases.length - 1 && open(phases[i]))) phases[i].name = `Phase ${i + 1}`;
    if (meta?.allowlistId) {
      const al = await one(`select root from allowlists where id = $1`, [meta.allowlistId]);
      if (!al || al.root.toLowerCase() !== phases[i].merkleRoot) throw bad(`Phase ${i + 1}: allowlist does not match the on-chain root`);
      phases[i].allowlistId = meta.allowlistId;
    }
  }
  const last = phases[phases.length - 1];
  if (last && open(last)) last.name = 'Public';
  await q(`update drops set phases = $2 where collection = $1`, [address, JSON.stringify(phases)]);
  res.json({ collection: await loadCollection(address), ...(warnings.length ? { warnings } : {}) });
}));

/** Social / website links: https only (no javascript:, data: or plain http links on the collection page). */
function safeLink(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`; // upgrade plain http
  else if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) s = `https://${s}`; // "x.com/name" → https://x.com/name
  if (s.length > 300 || !/^https:\/\/[^\s"'<>\\]+$/i.test(s)) throw bad('Links must start with https://');
  try { new URL(s); } catch { throw bad('That link is not valid'); }
  return s;
}

/** Logo / banner: an https://, ipfs:// or ar:// link in any image format (or an image embedded by an older version). */
function safeImage(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp);base64,[a-z0-9+/=]+$/i.test(s) && s.length < 1_300_000) return s;
  return cleanMediaLink(s, 'Image');
}

export default r;
