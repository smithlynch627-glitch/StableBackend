// Checks a creator's metadata folder before launch (and before a reveal), with exact, fixable findings:
// missing files, files numbered from 0, files without ".json", images that still point to a placeholder,
// image files that are not in the images folder, invalid JSON, and so on.
import { gatewayFetch, idOfName, loadFolder, parseIpfs, probeIpfs, resolveDir } from './ipfs.js';

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|mp4|webm|mov|glb|gltf|mp3|wav)$/i;
const clean = (m) => String(m || '').replace(/\s+/g, ' ').trim().slice(0, 160);

function mediaOf(m) {
  if (!m || typeof m !== 'object') return null;
  const v = [m.image, m.image_url, m.imageUrl, m.animation_url].find((x) => typeof x === 'string' && x.trim());
  if (v) return v.trim();
  if (typeof m.image_data === 'string' && m.image_data.includes('<svg')) return 'data:image/svg+xml';
  return null;
}
const isPlaceholder = (img) => /NewUriToReplace|YOUR_?CID|<.*CID.*>|REPLACE_?ME|ipfs:\/\/\s*\/|ipfs:\/\/CID\//i.test(img);
const toHttp = (u) => {
  const p = parseIpfs(u);
  return p && !p.bad ? `${(process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/').replace(/\/?$/, '/')}${[p.cid.toString(), ...p.segments.map(encodeURIComponent)].join('/')}` : u;
};

async function readEntry(e, timeout = 12_000) {
  const { value } = await gatewayFetch(e.cid.toString(), {
    timeout, maxBytes: 2_000_000, check: async (_r, buf) => JSON.parse(buf.toString('utf8').replace(/^﻿/, '')),
  });
  return value;
}

/**
 * Fast look at the folder: what is in it (one request) plus tokens 1, 2 and the last one.
 * stage: "found" (readable), "pending" (IPFS has not spread the upload yet — try again shortly), "bad" (fix needed).
 */
export async function inspectBase(base, supply) {
  const p = parseIpfs(base);
  if (!p) return null;
  if (p.bad) return { stage: 'bad', problems: [{ code: 'bad_cid', level: 'error', value: p.bad }] };
  let dir;
  try {
    dir = await resolveDir(p.cid, p.segments, { timeout: 10_000 });
  } catch (e) {
    if (e.notFound) return { stage: 'bad', problems: [{ code: 'path_missing', level: 'error', detail: clean(e.message) }] };
    // The folder listing did not come back: maybe only plain file links work right now. Try token #1 directly.
    try {
      const { value: m } = await gatewayFetch([p.cid.toString(), ...p.segments, '1.json'].map(encodeURIComponent).join('/'), {
        timeout: 8_000, maxBytes: 2_000_000, check: async (_r, buf) => JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')),
      });
      const media = mediaOf(m);
      return {
        stage: 'found', listing: false, problems: [],
        samples: [{ id: '1', file: '1.json', ok: true, name: typeof m.name === 'string' ? m.name.trim().slice(0, 80) : null, image: media && !media.startsWith('data:') ? toHttp(media) : null, rawImage: media ? media.slice(0, 200) : null, attributes: Array.isArray(m.attributes) ? m.attributes.length : 0, imageOk: null, placeholder: media ? isPlaceholder(media) : false }],
      };
    } catch (e2) {
      if (e2.notFound) return { stage: 'bad', problems: [{ code: 'first_missing', level: 'error' }] };
      return { stage: 'pending', detail: clean(e.message) };
    }
  }
  if (dir.type !== 'dir') return { stage: 'bad', problems: [{ code: 'single_file', level: 'error' }] };

  const entries = dir.entries;
  const tokenFiles = entries.filter((e) => idOfName(e.name) !== null);
  const problems = [];
  const out = { stage: 'found', cid: dir.cid.toString(), files: entries.length, tokenFiles: tokenFiles.length, problems, samples: [] };

  if (!tokenFiles.length) {
    const images = entries.filter((e) => IMG_EXT.test(e.name)).length;
    if (images > entries.length / 2) problems.push({ code: 'images_folder', level: 'error' });
    // A folder with one sub-folder inside (uploaded the parent folder): point at the sub-folder.
    const subs = entries.filter((e) => !/\.[a-z0-9]{2,5}$/i.test(e.name));
    for (const s of subs.slice(0, 3)) {
      try {
        const inner = await resolveDir(dir.cid, [s.name], { timeout: 10_000 });
        if (inner.type === 'dir' && inner.entries.some((e) => idOfName(e.name) !== null)) {
          problems.push({ code: 'use_subfolder', level: 'error', base: `${base.replace(/\/?$/, '/')}${encodeURIComponent(s.name)}/` });
          break;
        }
      } catch { /* not a folder */ }
    }
    if (!problems.length) problems.push({ code: 'no_token_files', level: 'error', example: entries.slice(0, 3).map((e) => e.name).join(', ') });
    return out;
  }

  const ids = new Map(tokenFiles.map((e) => [idOfName(e.name), e]));
  const noExt = tokenFiles.filter((e) => !/\.json$/i.test(e.name)).length;
  const nums = [...ids.keys()].map(Number);
  out.minId = Math.min(...nums);
  out.maxId = Math.max(...nums);
  const want = Number(supply) > 0 ? Math.min(Number(supply), 200_000) : out.maxId;
  const missing = [];
  let missingCount = 0;
  for (let i = 1; i <= want; i++) {
    if (!ids.has(String(i))) {
      missingCount += 1;
      if (missing.length < 12) missing.push(i);
    }
  }
  if (missingCount) {
    problems.push({ code: ids.has('0') && missingCount === 1 && !ids.has(String(want)) ? 'zero_based' : 'missing', level: 'error', count: missingCount, sample: missing, supply: want });
  } else if (ids.has('0')) {
    problems.push({ code: 'has_zero', level: 'info' });
  }
  const extra = nums.filter((n) => n > want).length;
  if (extra) problems.push({ code: 'extra', level: 'info', count: extra, supply: want });
  if (noExt) problems.push({ code: noExt === tokenFiles.length ? 'no_ext' : 'mixed_ext', level: 'warn', count: noExt });
  const others = entries.length - tokenFiles.length;
  if (others) problems.push({ code: 'other_files', level: 'info', count: others, example: entries.filter((e) => idOfName(e.name) === null).slice(0, 3).map((e) => e.name).join(', ') });

  // Samples: #1, #2 and the last token.
  const sampleIds = [...new Set(['1', '2', String(want)])].filter((i) => ids.has(i));
  out.samples = await Promise.all(sampleIds.map(async (id) => {
    const e = ids.get(id);
    try {
      const m = await readEntry(e);
      const media = mediaOf(m);
      const probe = media && !media.startsWith('data:') && !isPlaceholder(media)
        ? (parseIpfs(media) ? await probeIpfs(media, { timeout: 9_000 }) : { ok: null })
        : { ok: media ? null : false };
      return {
        id, file: e.name, ok: true, name: typeof m.name === 'string' ? m.name.trim().slice(0, 80) : null,
        image: media && !media.startsWith('data:') ? toHttp(media) : null, rawImage: media ? media.slice(0, 200) : null,
        attributes: Array.isArray(m.attributes) ? m.attributes.length : 0,
        imageOk: probe.ok, imageError: probe.ok === false ? clean(probe.error || (media ? '' : 'no image field')) : null,
        placeholder: media ? isPlaceholder(media) : false,
      };
    } catch (err) {
      return { id, file: e.name, ok: false, error: err instanceof SyntaxError ? 'not valid JSON' : clean(err.message) };
    }
  }));
  const read = out.samples.filter((x) => x.ok);
  const ph = read.find((x) => x.placeholder);
  if (ph) problems.push({ code: 'placeholder', level: 'error', example: ph.rawImage });
  else if (read.length && read.every((x) => !x.rawImage)) problems.push({ code: 'no_image', level: 'error' });
  else if (read.length && read.every((x) => x.imageOk === false)) problems.push({ code: 'image_unreachable', level: 'warn', example: read[0].rawImage, detail: read[0].imageError });
  const unreadable = out.samples.find((x) => !x.ok);
  if (unreadable) problems.push({ code: 'unreadable', level: 'error', id: unreadable.id, detail: unreadable.error });
  return out;
}

/**
 * Full check: reads every token file (one archive download for the whole folder) and the images folder.
 */
export async function validateBase(base, supply) {
  const p = parseIpfs(base);
  if (!p || p.bad) return null;
  const folder = await loadFolder(p.cid, p.segments, { timeout: 45_000, retryFailed: true });
  const want = Number(supply) > 0 ? Math.min(Number(supply), 200_000) : Math.max(0, ...[...folder.byId.keys()].map(Number));
  const result = { checked: 0, unreadable: [], invalid: [], noImage: [], noName: 0, placeholder: { count: 0, example: null }, rawCidPath: 0, images: null };
  const imageFolders = new Map(); // folder CID → Set of file names used
  let imagesOther = 0;
  for (let i = 1; i <= want; i++) {
    const name = folder.byId.get(String(i));
    if (!name) continue;
    const m = folder.byName.get(name);
    result.checked += 1;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      if (result.invalid.length < 10) result.invalid.push(i);
      continue;
    }
    if (typeof m.name !== 'string' || !m.name.trim()) result.noName += 1;
    const media = mediaOf(m);
    if (!media) {
      if (result.noImage.length < 10) result.noImage.push(i);
      continue;
    }
    if (isPlaceholder(media)) {
      result.placeholder.count += 1;
      result.placeholder.example ??= media.slice(0, 90);
      continue;
    }
    const ip = parseIpfs(media);
    if (ip?.bad) {
      result.placeholder.count += 1;
      result.placeholder.example ??= media.slice(0, 90);
    } else if (ip && ip.segments.length === 1) {
      if (/^bafkrei/i.test(ip.cid.toString())) result.rawCidPath += 1;
      else {
        const k = ip.cid.toString();
        if (!imageFolders.has(k)) imageFolders.set(k, new Map());
        imageFolders.get(k).set(ip.segments[0], i);
      }
    } else imagesOther += 1;
  }
  for (const [name, err] of folder.errors) {
    const id = idOfName(name);
    if (id && Number(id) <= want && result.unreadable.length < 10) result.unreadable.push({ id: Number(id), error: clean(err) });
  }
  // Images that live in one images folder: check every referenced file is really in it.
  if (imageFolders.size && imageFolders.size <= 3) {
    const images = { folders: imageFolders.size, referenced: 0, found: 0, missing: [], hint: null, pending: false };
    for (const [cid, used] of imageFolders) {
      images.referenced += used.size;
      try {
        const dir = await resolveDir(parseIpfs(`ipfs://${cid}`).cid, [], { timeout: 15_000 });
        if (dir.type !== 'dir') {
          images.missing.push({ id: [...used.values()][0], file: [...used.keys()][0] });
          continue;
        }
        const names = new Set(dir.entries.map((e) => e.name));
        const stems = new Map(dir.entries.map((e) => [e.name.replace(/\.[^.]+$/, ''), e.name]));
        for (const [file, id] of used) {
          if (names.has(file)) images.found += 1;
          else {
            if (images.missing.length < 10) images.missing.push({ id, file });
            // Same number, other extension (metadata says .png, the files are .jpg).
            const other = stems.get(file.replace(/\.[^.]+$/, ''));
            if (other && !images.hint) images.hint = { wrote: file, actual: other };
          }
        }
      } catch (e) {
        images.pending = !e.notFound;
        if (e.notFound) images.missing.push({ id: [...used.values()][0], file: [...used.keys()][0] });
      }
    }
    images.missingCount = Math.max(0, images.referenced - images.found);
    result.images = images;
  } else if (imagesOther || imageFolders.size > 3) {
    result.images = { folders: imageFolders.size, referenced: 0, found: 0, missing: [], separate: true };
  }
  result.ok = !result.invalid.length && !result.noImage.length && !result.placeholder.count && !result.unreadable.length
    && !(result.images && result.images.missing.length);
  return result;
}
