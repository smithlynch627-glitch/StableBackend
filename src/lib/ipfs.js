// Reading NFT metadata from IPFS quickly and reliably.
//
// Why this exists: public gateways are slow to find new uploads, rate-limit shared server IPs (HTTP 429) and
// sometimes hang. Asking them one after another, one file per token, made big collections crawl and fail.
//
// What it does instead:
//  • Hedged requests: the fastest-known gateway first, another one every ~0.8 s, first good answer wins.
//    Gateways that fail or rate-limit are rested for a while; the ones that answer fast move up.
//  • Folders are read as a whole: one small request lists the folder (so missing or misnamed files are
//    known exactly), one request downloads every JSON file as a verified CAR archive. After that each token's
//    metadata comes from memory, with no gateway call per token.
//  • Everything downloaded by CID is checked against its hash, so a bad gateway cannot serve wrong data.
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { identity } from 'multiformats/hashes/identity';
import { equals } from 'multiformats/bytes';
import * as raw from 'multiformats/codecs/raw';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CarBlockIterator } from '@ipld/car/iterator';

const DEFAULT_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/',
  'https://4everland.io/ipfs/', 'https://ipfs.filebase.io/ipfs/', 'https://nftstorage.link/ipfs/',
];
const slash = (g) => (g.endsWith('/') ? g : `${g}/`);
/** IPFS_GATEWAY (e.g. a dedicated gateway) is always tried first; IPFS_GATEWAYS replaces the public list. */
export const GATEWAYS = [...new Set([
  ...(process.env.IPFS_GATEWAY ? [process.env.IPFS_GATEWAY] : []),
  ...(process.env.IPFS_GATEWAYS ? process.env.IPFS_GATEWAYS.split(',') : DEFAULT_GATEWAYS),
].map((g) => g.trim()).filter(Boolean).map(slash))];

export class IpfsNotFound extends Error {
  constructor(message) { super(message); this.name = 'IpfsNotFound'; this.notFound = true; }
}

// ── Gateway health ────────────────────────────────────────────────────────────────────────────────────────
const health = new Map(GATEWAYS.map((g, i) => [g, { score: process.env.IPFS_GATEWAY && i === 0 ? 150 : 900 + i * 60, fails: 0, until: 0 }]));
function ranked() {
  const now = Date.now();
  const all = [...health.entries()].map(([g, h]) => ({ g, h, cost: h.score + h.fails * 1500 }));
  const ready = all.filter((x) => x.h.until <= now).sort((a, b) => a.cost - b.cost);
  // Everyone resting: still try them all, least-recently-failed first.
  return (ready.length ? ready : all.sort((a, b) => a.h.until - b.h.until)).map((x) => x.g);
}
function markGood(g, ms) {
  const h = health.get(g);
  if (!h) return;
  h.score = Math.round(h.score * 0.6 + ms * 0.4);
  h.fails = 0;
  h.until = 0;
}
function markBad(g, status) {
  const h = health.get(g);
  if (!h) return;
  h.fails += 1;
  h.score = Math.min(h.score + 400, 20_000);
  if (status === 429) h.until = Date.now() + 90_000; // rate-limited: rest for a while
  else if (h.fails >= 3) h.until = Date.now() + Math.min(20_000 * 2 ** (h.fails - 3), 300_000);
}
export const gatewayHealth = () => [...health.entries()].map(([g, h]) => ({ gateway: g, ...h }));

export async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error(`file too large (${len} bytes)`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      reader.cancel().catch(() => {});
      throw new Error(`file too large (over ${max} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * GET <gateway>/ipfs/<path><query> from several gateways: the best one first, one more every `stagger` ms (at
 * most `width` at a time). The first answer that passes `check` wins and the others are cancelled.
 * A 404 that says the file is not in the folder ends the race at once (IPFS content cannot change).
 */
export function gatewayFetch(path, { query = '', accept, timeout = 15_000, stagger = 800, width = 4, maxBytes = 2_000_000, check, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const order = ranked();
    const ctrls = [];
    const errors = [];
    let next = 0;
    let active = 0;
    let notFound = 0;
    let done = false;
    const finish = (value, err) => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      clearInterval(timer);
      ctrls.forEach((c) => c.abort());
      if (err) reject(err);
      else resolve(value);
    };
    const failAll = () => {
      const counts = {};
      for (const e of errors) counts[e] = (counts[e] || 0) + 1;
      const summary = Object.entries(counts).map(([e, n]) => (n > 1 ? `${e} ×${n}` : e)).join(', ');
      // Only when every gateway asked said 404 is it treated as missing (a slow one may still be looking).
      finish(null, notFound >= 2 && notFound === next ? new IpfsNotFound('not found on IPFS') : new Error(`no gateway could load it (${summary || 'timed out'})`));
    };
    const launch = () => {
      if (done || next >= order.length) return false;
      const g = order[next++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      active += 1;
      const t0 = Date.now();
      (async () => {
        let status = 0;
        try {
          const res = await fetch(`${g}${path}${query}`, { signal: ctrl.signal, redirect: 'follow', headers: { ...(accept ? { accept } : {}), ...headers } });
          status = res.status;
          if (res.status === 404 || res.status === 410) {
            const body = (await res.text().catch(() => '')).slice(0, 400);
            notFound += 1;
            if (/no link named|not a directory|path not found|does not exist/i.test(body)) return finish(null, new IpfsNotFound(body.replace(/\s+/g, ' ').trim().slice(0, 160) || 'not found'));
            throw new Error('HTTP 404');
          }
          if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
          const buf = await readCapped(res, maxBytes);
          const value = check ? await check(res, buf) : buf;
          markGood(g, Date.now() - t0);
          finish({ value, gateway: g, ms: Date.now() - t0 });
        } catch (e) {
          if (done) return;
          if (!(e instanceof IpfsNotFound)) markBad(g, status);
          errors.push(e.name === 'AbortError' ? 'cancelled' : e.cause?.code || e.message.slice(0, 80));
          active -= 1;
          if (!launch() && active === 0) failAll();
        }
      })();
      return true;
    };
    const overall = setTimeout(() => {
      errors.push('timed out');
      failAll();
    }, timeout);
    const timer = setInterval(() => {
      if (active < width) launch();
    }, stagger);
    launch();
  });
}

// ── Parsing ipfs:// links ─────────────────────────────────────────────────────────────────────────────────
/** ipfs://CID/a/b.json, ipfs://ipfs/CID/…, or any https://<gateway>/ipfs/CID/… link → { cid, segments }. */
export function parseIpfs(uri) {
  if (typeof uri !== 'string') return null;
  const m = uri.trim().match(/^(?:ipfs:\/\/(?:ipfs\/)?|https?:\/\/[^/]+\/ipfs\/)([a-zA-Z0-9]{40,})(\/[^?#]*)?/);
  if (!m) return null;
  let cid;
  try {
    cid = CID.parse(m[1]);
  } catch {
    return { bad: m[1] };
  }
  const segments = (m[2] || '').split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return { cid, segments };
}
const enc = (segments) => segments.map((s) => encodeURIComponent(s)).join('/');
const key = (cid) => Buffer.from(cid.multihash.bytes).toString('base64');

async function verify(cid, bytes) {
  const code = cid.multihash.code;
  if (code === sha256.code) return equals((await sha256.digest(bytes)).digest, cid.multihash.digest);
  if (code === identity.code) return equals(cid.multihash.digest, bytes);
  return true; // other hash functions are rare; accepted as served
}

/** One verified block (a folder node or a small file). */
const blockCache = new Map();
export async function getBlock(cid, { timeout = 12_000 } = {}) {
  const k = key(cid);
  if (blockCache.has(k)) return blockCache.get(k);
  const { value } = await gatewayFetch(cid.toString(), {
    query: '?format=raw', accept: 'application/vnd.ipld.raw', timeout, maxBytes: 4_000_000,
    check: async (_res, buf) => {
      if (!(await verify(cid, buf))) throw new Error('gateway sent the wrong data');
      return new Uint8Array(buf);
    },
  });
  if (value.length < 400_000) {
    if (blockCache.size > 4000) blockCache.clear();
    blockCache.set(k, value);
  }
  return value;
}

/** What a CID is, and for folders every entry (large "sharded" folders included). */
export async function listCid(cid, { timeout = 12_000, maxEntries = 60_000 } = {}) {
  if (cid.code === raw.code) return { type: 'file' };
  if (cid.code !== dagPb.code) return { type: 'other' };
  const node = dagPb.decode(await getBlock(cid, { timeout }));
  let fs;
  try {
    fs = UnixFS.unmarshal(node.Data);
  } catch {
    return { type: 'other' };
  }
  if (fs.type === 'directory') {
    return { type: 'dir', entries: node.Links.map((l) => ({ name: l.Name ?? '', cid: l.Hash, size: Number(l.Tsize ?? 0) })) };
  }
  if (fs.type === 'hamt-sharded-directory') {
    const pad = (BigInt(fs.fanout ?? 256n) - 1n).toString(16).length;
    const entries = [];
    const walk = async (n) => {
      const subs = [];
      for (const l of n.Links) {
        if ((l.Name ?? '').length > pad) entries.push({ name: l.Name.slice(pad), cid: l.Hash, size: Number(l.Tsize ?? 0) });
        else subs.push(l.Hash);
      }
      if (entries.length > maxEntries) throw new Error('folder has too many files');
      for (let i = 0; i < subs.length; i += 8) {
        await Promise.all(subs.slice(i, i + 8).map(async (c) => walk(dagPb.decode(await getBlock(c, { timeout })))));
      }
    };
    await walk(node);
    return { type: 'dir', entries, sharded: true };
  }
  return { type: fs.type === 'file' || fs.type === 'raw' ? 'file' : 'other' };
}

/** Follows a path inside a folder (ipfs://CID/metadata/ → the "metadata" folder). */
export async function resolveDir(cid, segments, opts) {
  let cur = cid;
  let listing = await listCid(cur, opts);
  for (const seg of segments) {
    if (listing.type !== 'dir') throw new IpfsNotFound(`"${seg}" is not inside a folder`);
    const hit = listing.entries.find((e) => e.name === seg);
    if (!hit) throw new IpfsNotFound(`no "${seg}" in this folder`);
    cur = hit.cid;
    listing = await listCid(cur, opts);
  }
  return { cid: cur, ...listing };
}

// ── Reading whole folders ─────────────────────────────────────────────────────────────────────────────────
/** 1 → 1, "1.json" → 1, "0001.json" → 1, "cat-1.json" → null. */
export const idOfName = (name) => {
  const m = /^(\d{1,12})(\.json)?$/i.exec(name);
  return m ? String(BigInt(m[1])) : null;
};
const isJsonLike = (name) => /\.json$/i.test(name) || /^\d{1,12}$/.test(name);

function fileFromBlocks(cid, blocks, depth = 0) {
  const b = blocks.get(key(cid));
  if (!b || depth > 20) return null;
  if (cid.code === raw.code) return b;
  if (cid.code !== dagPb.code) return null;
  const node = dagPb.decode(b);
  const fs = UnixFS.unmarshal(node.Data);
  if (fs.type !== 'file' && fs.type !== 'raw') return null;
  if (!node.Links.length) return fs.data ?? new Uint8Array();
  const parts = fs.data?.length ? [fs.data] : [];
  for (const l of node.Links) {
    const p = fileFromBlocks(l.Hash, blocks, depth + 1);
    if (!p) return null;
    parts.push(p);
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

// Memory guard: whole-folder archives are big, so only a couple download at a time (others wait their turn).
const CAR_MAX_BYTES = Math.max(4, Number(process.env.IPFS_CAR_MAX_MB || 48)) * 1_000_000;
const CAR_SLOTS = Math.max(1, Number(process.env.IPFS_CAR_PARALLEL || 2));
let carActive = 0;
const carQueue = [];
async function carSlot(fn) {
  if (carActive >= CAR_SLOTS) {
    if (carQueue.length >= 50) throw new Error('IPFS is busy. Try again in a minute.');
    await new Promise((res) => carQueue.push(res));
  }
  carActive += 1;
  try {
    return await fn();
  } finally {
    carActive -= 1;
    carQueue.shift()?.();
  }
}

/** Downloads a whole folder as one CAR archive (every block hash-checked). */
function fetchCar(cid, opts) {
  return carSlot(() => fetchCarNow(cid, opts));
}
async function fetchCarNow(cid, { timeout = 60_000, maxBytes = CAR_MAX_BYTES } = {}) {
  const { value } = await gatewayFetch(cid.toString(), {
    query: '?format=car&dag-scope=all', accept: 'application/vnd.ipld.car;version=1;order=dfs;dups=n,application/vnd.ipld.car',
    timeout, maxBytes: Math.min(maxBytes, CAR_MAX_BYTES), width: 2, stagger: 2500,
    check: async (_res, buf) => {
      const blocks = new Map();
      const it = await CarBlockIterator.fromBytes(new Uint8Array(buf));
      for await (const { cid: c, bytes } of it) {
        if (!(await verify(c, bytes))) throw new Error('gateway sent the wrong data');
        blocks.set(key(c), bytes);
      }
      if (!blocks.has(key(cid))) throw new Error('archive is missing the folder itself');
      return blocks;
    },
  });
  return value;
}

const parseJson = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^﻿/, ''));

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }));
}

/**
 * Every JSON file of a metadata folder, as { byName, byId, missing, complete }.
 * Kept in memory (folders never change), so repeated reads cost nothing.
 */
const folders = new Map(); // key → { files, bytes, at }
const inflight = new Map();
const failures = new Map(); // key → { at, n }
let cachedBytes = 0;
const MAX_CACHE = Number(process.env.IPFS_CACHE_MB || 96) * 1_000_000;

function remember(k, folder) {
  folders.set(k, folder);
  cachedBytes += folder.bytes;
  for (const [old, f] of folders) {
    if (cachedBytes <= MAX_CACHE || old === k) break;
    folders.delete(old);
    cachedBytes -= f.bytes;
  }
}

export async function loadFolder(cid, segments = [], { timeout = 60_000, retryFailed = false } = {}) {
  const k = `${cid.toString()}/${segments.join('/')}`;
  const hit = folders.get(k);
  if (hit) {
    folders.delete(k); // most recently used goes last
    folders.set(k, hit);
    return hit;
  }
  const fail = failures.get(k);
  if (fail && !retryFailed && Date.now() - fail.at < Math.min(15_000 * 2 ** (fail.n - 1), 300_000)) throw fail.err;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    const dir = await resolveDir(cid, segments, { timeout: Math.min(timeout, 15_000) });
    if (dir.type !== 'dir') throw new IpfsNotFound('this link is a single file, not a folder');
    const jsonEntries = dir.entries.filter((e) => isJsonLike(e.name));
    const other = dir.entries.filter((e) => !isJsonLike(e.name));
    const byName = new Map();
    const errors = new Map();
    let bytes = 0;
    const store = (e, data) => {
      try {
        const json = parseJson(data);
        byName.set(e.name, json);
        bytes += data.length;
      } catch {
        errors.set(e.name, 'not valid JSON');
      }
    };
    const jsonSize = jsonEntries.reduce((s, e) => s + e.size, 0);
    const otherSize = other.reduce((s, e) => s + e.size, 0);
    let todo = jsonEntries;
    // One archive for the whole folder, unless it also holds big files (images) we do not need.
    if (jsonEntries.length && jsonSize < 48_000_000 && otherSize < 4_000_000) {
      try {
        const blocks = await fetchCar(dir.cid, { timeout });
        todo = [];
        for (const e of jsonEntries) {
          const data = fileFromBlocks(e.cid, blocks);
          if (data) store(e, data);
          else todo.push(e);
        }
      } catch {
        // No gateway gave the archive: read the files one by one below.
      }
    }
    // Anything the archive did not cover: file by file (by CID, so any gateway works), 8 at a time.
    await mapLimit(todo, 8, async (e) => {
      try {
        const { value } = await gatewayFetch(e.cid.toString(), {
          timeout: 20_000, maxBytes: 2_000_000,
          check: async (_res, buf) => {
            if (e.cid.code === raw.code && !(await verify(e.cid, buf))) throw new Error('gateway sent the wrong data');
            return buf;
          },
        });
        store(e, value);
      } catch (err) {
        errors.set(e.name, err.message.slice(0, 120));
      }
    });
    const byId = new Map();
    for (const name of byName.keys()) {
      const id = idOfName(name);
      if (id !== null && !byId.has(id)) byId.set(id, name);
    }
    return { cid: dir.cid, entries: dir.entries, byName, byId, errors, complete: errors.size === 0, bytes: bytes + dir.entries.length * 80, at: Date.now() };
  })();
  inflight.set(k, p);
  try {
    const folder = await p;
    failures.delete(k);
    remember(k, folder); // files that failed are fetched one by one when asked for
    return folder;
  } catch (err) {
    const n = (failures.get(k)?.n || 0) + 1;
    failures.set(k, { at: Date.now(), n, err });
    throw err;
  } finally {
    inflight.delete(k);
  }
}

// ── Reading one JSON file ────────────────────────────────────────────────────────────────────────────────
const jsonCache = new Map();
/**
 * Metadata JSON from any ipfs:// (or https://…/ipfs/…) link. Token files inside a folder come from the
 * folder cache; "1.json" also finds a file saved as "1" (and the other way round).
 */
export async function readIpfsJson(uri, { timeout = 20_000 } = {}) {
  const p = parseIpfs(uri);
  if (!p) throw new Error('not an IPFS link');
  if (p.bad) throw new Error(`"${p.bad}" is not a valid IPFS CID`);
  const { cid, segments } = p;
  const file = segments.at(-1);
  const cacheKey = `${cid.toString()}/${segments.join('/')}`;
  if (jsonCache.has(cacheKey)) return jsonCache.get(cacheKey);
  if (file && idOfName(file) !== null) {
    try {
      const folder = await loadFolder(cid, segments.slice(0, -1), { timeout: Math.max(timeout, 45_000) });
      const name = folder.byName.has(file) ? file : folder.byId.get(idOfName(file));
      if (name !== undefined) return folder.byName.get(name);
      if (folder.complete) throw new IpfsNotFound(`${file} is not in the folder`);
    } catch (e) {
      if (e.notFound) throw e;
      // Folder could not be read as a whole: fall back to this one file.
    }
  }
  const { value } = await gatewayFetch(enc([cid.toString(), ...segments]), {
    accept: 'application/json, */*;q=0.5', timeout, maxBytes: 2_000_000, check: async (_res, buf) => parseJson(buf),
  });
  if (jsonCache.size > 2000) jsonCache.clear();
  jsonCache.set(cacheKey, value);
  return value;
}

/** Does an IPFS image/video link load? (first bytes only, hedged across gateways) */
export async function probeIpfs(uri, { timeout = 10_000 } = {}) {
  const p = parseIpfs(uri);
  if (!p) return { ok: false, error: 'not an IPFS link' };
  if (p.bad) return { ok: false, error: `"${p.bad}" is not a valid IPFS CID` };
  try {
    const { gateway } = await gatewayFetch(enc([p.cid.toString(), ...p.segments]), {
      timeout, maxBytes: 70_000, headers: { range: 'bytes=0-2047' },
      check: async (res) => {
        if (/^text\/html/i.test(res.headers.get('content-type') || '')) throw new Error('the link opens a folder, not a file');
        return true;
      },
    });
    return { ok: true, url: `${gateway}${enc([p.cid.toString(), ...p.segments])}` };
  } catch (e) {
    return { ok: false, error: e.notFound ? 'file not found on IPFS' : e.message };
  }
}
