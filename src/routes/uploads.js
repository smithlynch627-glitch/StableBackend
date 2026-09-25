// Images and IPFS. The Pinata JWT never leaves the server: browsers get a single-use, upload-only key.
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { one } from '../db.js';
import { ah, bad, notFound } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { audit } from '../lib/admin.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const perWallet = (limit, windowMs) =>
  rateLimit({ windowMs, limit, keyGenerator: (req) => req.user || req.ip, standardHeaders: 'draft-7', legacyHeaders: false });
const IMAGE = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)$/;

// Magic-byte check so a renamed file cannot pretend to be an image.
function sniff(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp' && /^avi[fs]$/.test(buf.subarray(8, 12).toString('ascii'))) return 'image/avif';
  // BMP: "BM" plus a known header size, so a text file starting with "BM" is not mistaken for one.
  if (buf.length > 26 && buf.subarray(0, 2).toString('ascii') === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) return 'image/bmp';
  // SVG is text: served back with a sandboxed Content-Security-Policy, so scripts inside it can never run.
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml|<svg|<!--|<!doctype svg)/i.test(head) && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

async function pinFile(buffer, mime, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), name);
  fd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${config.pinataJwt}` }, body: fd });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.IpfsHash) throw bad('IPFS upload failed. Check PINATA_JWT on the server.');
  return j.IpfsHash;
}

async function pinJson(content, name) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.pinataJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name }, pinataOptions: { cidVersion: 1 } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.IpfsHash) throw bad('IPFS upload failed. Check PINATA_JWT on the server.');
  return j.IpfsHash;
}

async function storeMedia(owner, buffer, mime) {
  if (buffer.length > 2 * 1024 * 1024) throw bad('Image must be under 2 MB (or configure IPFS on the server)');
  const sha = createHash('sha256').update(buffer).digest('hex');
  const row = await one(
    `insert into app.media (owner, mime, bytes, size, sha256) values ($1,$2,$3,$4,$5)
     on conflict (owner, sha256) do update set mime = excluded.mime returning id`,
    [owner, mime, buffer, buffer.length, sha],
  );
  return `${config.apiPublicUrl}/api/media/${row.id}`;
}

function readImage(req) {
  const f = req.file;
  if (!f) throw bad('Choose an image to upload');
  const mime = sniff(f.buffer);
  if (!mime || !IMAGE.test(mime)) throw bad('Upload a PNG, JPG, GIF, WebP, AVIF, SVG or BMP image');
  return { buffer: f.buffer, mime, name: (f.originalname || 'image').replace(/[^\w.-]/g, '_').slice(0, 80) };
}

/** Logo / banner / any single image. IPFS when configured, otherwise hosted by the API. */
r.post('/', requireAuth, perWallet(60, 3600_000), upload.single('file'), ah(async (req, res) => {
  const img = readImage(req);
  if (config.pinataJwt) {
    const cid = await pinFile(img.buffer, img.mime, img.name);
    return res.json({ uri: `ipfs://${cid}`, url: `https://ipfs.io/ipfs/${cid}` });
  }
  const url = await storeMedia(req.user, img.buffer, img.mime);
  res.json({ uri: url, url });
}));

/** Launch with just one pre-reveal image: builds the placeholder metadata the contract will point to. */
r.post('/prereveal', requireAuth, perWallet(30, 3600_000), upload.single('file'), ah(async (req, res) => {
  const img = readImage(req);
  const name = String(req.body?.name || 'Unrevealed').trim().slice(0, 80);
  const description = String(req.body?.description || '').trim().slice(0, 1000);
  if (config.pinataJwt) {
    const imageCid = await pinFile(img.buffer, img.mime, img.name);
    const jsonCid = await pinJson({ name, description, image: `ipfs://${imageCid}` }, `${name}-prereveal`);
    return res.json({ uri: `ipfs://${jsonCid}`, image: `ipfs://${imageCid}`, storage: 'ipfs' });
  }
  const image = await storeMedia(req.user, img.buffer, img.mime);
  const json = Buffer.from(JSON.stringify({ name, description, image })).toString('base64');
  res.json({ uri: `data:application/json;base64,${json}`, image, storage: 'onchain' });
}));

/** Single-use, upload-only Pinata key so the browser can upload a whole folder straight to IPFS. */
r.post('/ipfs-key', requireAuth, perWallet(20, 24 * 3600_000), ah(async (req, res) => {
  if (!config.pinataJwt) throw bad('IPFS uploads are not configured on this server. Paste an existing ipfs:// URI instead.', 'no_ipfs');
  const resp = await fetch('https://api.pinata.cloud/users/generateApiKey', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.pinataJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      keyName: `stable-${req.user.slice(2, 10)}-${Date.now()}`,
      maxUses: 1,
      permissions: { endpoints: { pinning: { pinFileToIPFS: true } } },
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.JWT) throw bad('Could not create an upload key. Check PINATA_JWT permissions (needs API key admin).');
  await audit(req, 'ipfs.key', req.user);
  res.json({ jwt: j.JWT, endpoint: 'https://api.pinata.cloud/pinning/pinFileToIPFS' });
}));

export const media = Router();
media.get('/:id', ah(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound();
  const m = await one(`select mime, bytes from app.media where id = $1`, [req.params.id]);
  if (!m) throw notFound();
  res.set({
    'Content-Type': m.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // SVGs may use inline styles and embedded (data:) images; the sandbox still blocks any script.
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(m.bytes);
}));

export default r;
