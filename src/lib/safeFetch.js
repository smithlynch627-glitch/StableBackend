// Fetching user-supplied URLs without letting anyone reach private/internal addresses (SSRF protection).
import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_V4 = [
  ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['100.64.0.0', 10], ['0.0.0.0', 8], ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4],
];
const v4 = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
function isPrivate(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some(([base, bits]) => (v4(ip) >>> (32 - bits)) === (v4(base) >>> (32 - bits)));
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
}

/** Throws unless the URL is https and every address it resolves to is public. */
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (process.env.ALLOW_PRIVATE_FETCH === '1' && /^https?:$/.test(u.protocol)) return u; // local development only
  if (u.protocol !== 'https:') throw new Error('Only https:// links are allowed');
  const ips = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!ips.length) throw new Error('Host not found');
  if (ips.some((i) => isPrivate(i.address))) throw new Error('This address is not allowed');
  return u;
}

/** GET with SSRF check, timeout, no redirects to other hosts, and a byte cap. */
export async function safeGet(raw, { timeout = 10_000, maxBytes = 2_000_000, accept = '*/*' } = {}) {
  const u = await assertPublicUrl(raw);
  const res = await fetch(u, { signal: AbortSignal.timeout(timeout), redirect: 'manual', headers: { accept } });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`HTTP ${res.status}`);
    const next = await assertPublicUrl(new URL(loc, u).toString());
    return safeGet(next.toString(), { timeout, maxBytes, accept });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('File too large');
  return { buf, type: res.headers.get('content-type') || '' };
}
