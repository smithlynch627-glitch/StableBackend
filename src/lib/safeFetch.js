// Fetching user-supplied URLs without letting anyone reach private/internal addresses (SSRF protection).
// - Every address a host resolves to is checked, and the check happens at CONNECT time inside the socket's own
//   DNS lookup, so a host that answers "public" first and "127.0.0.1" a moment later (DNS rebinding) is refused.
// - IPv4, IPv6, IPv4-mapped / NAT64 / 6to4 / Teredo forms of private addresses are all refused.
// - Bodies are streamed with a hard byte cap (a huge file is cut off, never buffered whole).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const DEV = () => process.env.ALLOW_PRIVATE_FETCH === '1'; // local development only

const blocked = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(a, bits, 'ipv6');

/** True only for addresses on the public internet. */
export function isPublicIp(ip) {
  const addr = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(addr)) return !blocked.check(addr, 'ipv4');
  if (!net.isIPv6(addr)) return false;
  // IPv4-mapped (::ffff:1.2.3.4 or ::ffff:0102:0304) and IPv4-compatible (::1.2.3.4): judge the IPv4 inside.
  const mapped = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPublicIp(mapped[1]);
  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !blocked.check(addr, 'ipv6');
}

/** DNS lookup used by the socket itself: fails if ANY answer is not public. */
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
    if (!list.length) return cb(new Error('Host not found'));
    if (!DEV() && list.some((a) => !isPublicIp(a.address))) return cb(new Error('This address is not allowed'));
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function parseAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.username || u.password) throw new Error('Links with a user name or password are not allowed');
  if (DEV() && /^https?:$/.test(u.protocol)) return u;
  if (u.protocol !== 'https:') throw new Error('Only https:// links are allowed');
  if (u.port && u.port !== '443') throw new Error('Only the standard https port is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('This address is not allowed');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('This address is not allowed');
  return u;
}

/** Throws unless the URL is https and every address it resolves to right now is public. */
export async function assertPublicUrl(raw) {
  const u = parseAllowed(raw);
  if (DEV()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;
  const ips = await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!ips.length) throw new Error('Host not found');
  if (ips.some((i) => !isPublicIp(i.address))) throw new Error('This address is not allowed');
  return u;
}

function requestOnce(u, { timeout, maxBytes, headers, bodyWanted }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'user-agent': 'STABLE-metadata/1.0', ...headers },
      lookup: safeLookup,
      timeout,
      agent: false,
    });
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeout);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      const done = (v) => { clearTimeout(timer); resolve(v); };
      const meta = { status: res.statusCode, headers: res.headers, type: String(res.headers['content-type'] || '') };
      if (!bodyWanted || res.statusCode >= 300) {
        res.resume();
        res.destroy();
        return done({ ...meta, buf: Buffer.alloc(0) });
      }
      const len = Number(res.headers['content-length'] || 0);
      if (len > maxBytes) {
        res.destroy();
        clearTimeout(timer);
        return reject(new Error('File too large'));
      }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) {
          res.destroy();
          clearTimeout(timer);
          reject(new Error('File too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done({ ...meta, buf: Buffer.concat(chunks) }));
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.end();
  });
}

async function safeRequest(raw, { timeout = 10_000, maxBytes = 2_000_000, accept = '*/*', headers = {}, bodyWanted = true } = {}) {
  let u = parseAllowed(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await requestOnce(u, { timeout, maxBytes, headers: { accept, ...headers }, bodyWanted });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      if (!loc) throw new Error(`HTTP ${res.status}`);
      u = parseAllowed(new URL(loc, u).toString());
      continue;
    }
    return { ...res, url: u.toString() };
  }
  throw new Error('Too many redirects');
}

/** GET with SSRF protection, timeout, checked redirects and a byte cap. */
export async function safeGet(raw, opts = {}) {
  const res = await safeRequest(raw, opts);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return { buf: res.buf, type: res.type, url: res.url };
}

/** Checks that a link answers (first 2 KB only), with the same protection. */
export async function safeProbe(raw, { timeout = 10_000 } = {}) {
  const res = await safeRequest(raw, { timeout, maxBytes: 70_000, headers: { range: 'bytes=0-2047' }, bodyWanted: false });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, type: res.type, url: res.url };
}

/**
 * Pixel size of a PNG / JPEG / GIF / WebP from its first bytes (no decoding), so a small file that claims to be
 * 100,000 × 100,000 pixels ("decompression bomb") can be refused before an image library opens it.
 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('latin1', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8X' && buf.length >= 30) return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && buf.length >= 30) return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** Refuses images bigger than `maxPixels` (default 40 megapixels) or with unreadable size. */
export function assertSafeImage(buf, maxPixels = 40_000_000) {
  const s = imageSize(buf);
  if (!s || !s.w || !s.h) throw new Error('Unknown image size');
  if (s.w > 16_384 || s.h > 16_384 || s.w * s.h > maxPixels) throw new Error(`Image is too large (${s.w}×${s.h} pixels)`);
  return s;
}
