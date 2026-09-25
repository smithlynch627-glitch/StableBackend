// Metadata preview for the Create page, and share cards (Open Graph) for collection links.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createRequire } from 'node:module';
import { formatEther } from 'ethers';
import { config } from '../config.js';
import { ah, bad, notFound } from '../lib/http.js';
import { loadCollection } from '../lib/queries.js';
import { safeGet } from '../lib/safeFetch.js';
import { fetchJsonUri, hasRawCidPath, ipfsToHttp, probeImage } from '../indexer/core.js';

const r = Router();
r.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

const DEV = process.env.ALLOW_PRIVATE_FETCH === '1';
const isAllowedUri = (u) => /^(ipfs:\/\/|ar:\/\/|https:\/\/)/.test(u) || (DEV && u.startsWith('http://'));
async function readMeta(uri) {
  if (/^https?:\/\//.test(uri)) {
    const { buf } = await safeGet(uri, { maxBytes: 1_000_000, accept: 'application/json' });
    return JSON.parse(buf.toString('utf8'));
  }
  return fetchJsonUri(uri, { timeout: 10_000 });
}

/**
 * GET /api/share/metadata?base=ipfs://CID/&ids=1,2,3  → checks the folder the contract will point to (base + id + ".json")
 * GET /api/share/metadata?uri=ipfs://…/hidden.json     → checks one metadata file (e.g. pre-reveal)
 */
r.get('/metadata', ah(async (req, res) => {
  const base = String(req.query.base || '').trim();
  const single = String(req.query.uri || '').trim();
  if (single) {
    if (!isAllowedUri(single) && !single.startsWith('data:application/json')) throw bad('Use an ipfs://, ar:// or https:// link');
    try {
      const m = await readMeta(single);
      return res.json({ items: [{ ok: true, name: m.name ?? null, image: ipfsToHttp(m.image || m.image_url || null), attributes: Array.isArray(m.attributes) ? m.attributes.length : 0 }] });
    } catch (e) {
      return res.json({ items: [{ ok: false, error: e.message }] });
    }
  }
  if (!isAllowedUri(base)) throw bad('Base URI must start with ipfs://, ar:// or https://');
  if (!base.endsWith('/')) throw bad('Base URI must end with "/" (the contract adds "<id>.json")');
  const ids = [...new Set(String(req.query.ids || '1,2,3').split(',').map((x) => x.trim()).filter((x) => /^\d{1,6}$/.test(x)))].slice(0, 5);
  const items = await Promise.all(ids.map(async (id) => {
    const uri = `${base}${id}.json`;
    try {
      const m = await readMeta(uri);
      const attrs = Array.isArray(m.attributes) ? m.attributes : [];
      const raw = m.image || m.image_url || null;
      // Is the image itself reachable? (Metadata can load while its image link is broken.)
      const probe = raw ? await probeImage(raw) : { ok: false, error: 'no image field' };
      return {
        id, uri, ok: true, name: typeof m.name === 'string' ? m.name.trim() : null, image: ipfsToHttp(raw), attributes: attrs.slice(0, 20), hasImage: Boolean(raw),
        rawImage: typeof raw === 'string' ? raw.slice(0, 300) : null,
        imageIssue: hasRawCidPath(raw) || probe.bareCid ? 'raw_cid_path' : null,
        imageOk: probe.ok, imageError: probe.ok ? null : probe.error,
      };
    } catch (e) {
      return { id, uri, ok: false, error: e.message };
    }
  }));
  res.json({ items });
}));

// ── Share cards ─────────────────────────────────────────────────────────────
// The image renderer is loaded on first use, so a missing native package can never stop the API from starting.
const require = createRequire(import.meta.url);
let renderer = null;
async function getRenderer() {
  if (renderer) return renderer;
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const fontDir = require.resolve('@expo-google-fonts/inter/package.json').replace(/package\.json$/, '');
    const fonts = ['Inter_400Regular.ttf', 'Inter_600SemiBold.ttf', 'Inter_800ExtraBold.ttf'].map((f) => `${fontDir}${f}`);
    renderer = { Resvg, fonts };
    return renderer;
  } catch (e) {
    throw new Error(`Share cards need "npm install" in the backend folder (${e.code || e.message})`);
  }
}
const cache = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function ethShort(wei) {
  if (wei === null || wei === undefined) return '—';
  const n = Number(formatEther(BigInt(wei)));
  if (n === 0) return '0 ETH';
  return `${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(3)} ETH`.replace(/\.?0+ ETH$/, ' ETH');
}

function statsOf(c) {
  return [
    ['Floor', ethShort(c.floor_wei)], ['Best offer', ethShort(c.best_offer_wei)],
    ['24h volume', ethShort(c.volume_24h_wei)], ['Total volume', ethShort(c.volume_wei)],
    ['Items', Number(c.total_supply || 0).toLocaleString('en-US')], ['Owners', Number(c.owners_count || 0).toLocaleString('en-US')],
  ];
}

async function imageDataUri(url) {
  if (!url) return null;
  try {
    const { buf } = await safeGet(ipfsToHttp(url), { maxBytes: 4_000_000, timeout: 6000 });
    const sig = buf.subarray(0, 4).toString('hex');
    const mime = sig.startsWith('89504e47') ? 'image/png' : sig.startsWith('ffd8ff') ? 'image/jpeg' : sig.startsWith('47494638') ? 'image/gif' : null;
    return mime ? `data:${mime};base64,${buf.toString('base64')}` : null; // (WebP/SVG are skipped)
  } catch {
    return null;
  }
}

async function renderCard(c) {
  const img = await imageDataUri(c.image_url);
  const name = c.name.length > 24 ? `${c.name.slice(0, 23)}…` : c.name;
  const stats = statsOf(c);
  const cells = stats.map(([k, v], i) => {
    const x = 560 + (i % 2) * 300;
    const y = 318 + Math.floor(i / 2) * 92;
    return `<text x="${x}" y="${y}" font-family="Inter" font-size="22" font-weight="400" fill="#6b6b6b">${esc(k)}</text>
            <text x="${x}" y="${y + 40}" font-family="Inter" font-size="34" font-weight="800" fill="#0a0a0a">${esc(v)}</text>`;
  }).join('');
  const art = img
    ? `<clipPath id="r"><rect x="70" y="105" width="420" height="420" rx="36"/></clipPath><image href="${img}" x="70" y="105" width="420" height="420" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/>`
    : `<rect x="70" y="105" width="420" height="420" rx="36" fill="#0a0a0a"/><text x="280" y="345" text-anchor="middle" font-family="Inter" font-size="150" font-weight="800" fill="#ffffff">${esc(c.name.slice(0, 1).toUpperCase())}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#ffffff"/>
    ${art}
    <rect x="70" y="105" width="420" height="420" rx="36" fill="none" stroke="#e6e6e6" stroke-width="2"/>
    <text x="560" y="175" font-family="Inter" font-size="${name.length > 16 ? 46 : 58}" font-weight="800" fill="#0a0a0a">${esc(name)}</text>
    <text x="560" y="222" font-family="Inter" font-size="24" font-weight="600" fill="#6b6b6b">${c.is_official ? 'Official collection' : c.verified ? 'Verified collection' : 'NFT collection'} on STABLE · GIWA</text>
    ${cells}
    <rect x="0" y="582" width="1200" height="48" fill="#0a0a0a"/>
    <text x="70" y="614" font-family="Inter" font-size="22" font-weight="800" fill="#ffffff">STABLE</text>
    <text x="1130" y="614" text-anchor="end" font-family="Inter" font-size="20" font-weight="400" fill="#bdbdbd">NFTs Launchpad &amp; Marketplace</text>
  </svg>`;
  const { Resvg, fonts } = await getRenderer();
  return new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}

const SLUG = /^([a-z0-9-]{1,80}|0x[0-9a-fA-F]{40})$/;

/** PNG card: collection image + floor, best offer, 24h / total volume, items, owners. */
r.get('/collection/:slug.png', ah(async (req, res) => {
  if (!SLUG.test(req.params.slug)) throw notFound();
  const c = await loadCollection(req.params.slug);
  const key = `${c.address}:${c.floor_wei}:${c.best_offer_wei}:${c.volume_24h_wei}:${c.volume_wei}:${c.image_url}:${c.name}`;
  let png = cache.get(key);
  if (!png) {
    png = await renderCard(c);
    if (cache.size > 300) cache.clear();
    cache.set(key, png);
  }
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(png);
}));

/** Tags for link previews (used by the website's edge function). */
r.get('/collection/:slug', ah(async (req, res) => {
  if (!SLUG.test(req.params.slug)) throw notFound();
  const c = await loadCollection(req.params.slug);
  const s = Object.fromEntries(statsOf(c));
  res.set('Cache-Control', 'public, max-age=120');
  res.json({
    title: `${c.name} | STABLE`,
    description: `Floor ${s.Floor}, best offer ${s['Best offer']}, 24h volume ${s['24h volume']}, total volume ${s['Total volume']}. ${s.Items} items, ${s.Owners} owners on GIWA.`,
    image: `${config.apiPublicUrl}/api/share/collection/${c.slug}.png?v=${Math.floor(Date.now() / 600_000)}`,
    slug: c.slug,
  });
}));

export default r;
