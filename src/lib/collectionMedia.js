// Collection pictures set by the creator (Create / Studio) or an admin: logo, banner and up to three extra
// images shown beside the logo on the mint page. Images are links only (https://, ipfs:// or ar://); the
// file type is not restricted, so PNG, JPG, GIF, WebP, AVIF, SVG and BMP all work.
import { currentChainSchema, one } from '../db.js';
import { bad } from './http.js';

export const MAX_GALLERY = 3;

const LINK = /^(https:\/\/[^\s"'<>\\]{4,500}|ipfs:\/\/[A-Za-z0-9._\-/?=&%]{10,500}|ar:\/\/[A-Za-z0-9_\-/.]{10,500})$/;

/** A hosted image link, or null when the field is empty. */
export function cleanMediaLink(v, name = 'Image') {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!LINK.test(s)) throw bad(`${name}: use an https://, ipfs:// or ar:// link to the image`);
  if (s.startsWith('https://')) { try { new URL(s); } catch { throw bad(`${name}: this link is not valid`); } }
  return s;
}

/** Up to three extra images. Empty rows and repeats are dropped. */
export function cleanGallery(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw bad('Extra images must be a list of links');
  const out = [];
  for (const [i, v] of list.entries()) {
    const s = cleanMediaLink(v, `Extra image ${i + 1}`);
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > MAX_GALLERY) throw bad(`You can add up to ${MAX_GALLERY} extra images`);
  return out;
}

// The "gallery" column is added by db/06_gallery.sql. Until that script has run the API keeps working
// (collections simply have no extra images) instead of failing on every collection page.
let seen = { schema: null, ok: false, at: 0 };
export async function galleryReady() {
  const schema = currentChainSchema();
  if (seen.schema === schema && (seen.ok || Date.now() - seen.at < 60_000)) return seen.ok;
  let ok = false;
  try {
    ok = !!(await one(
      `select 1 as ok from information_schema.columns where table_schema = $1 and table_name = 'collections' and column_name = 'gallery'`,
      [schema],
    ));
  } catch { ok = false; }
  seen = { schema, ok, at: Date.now() };
  return ok;
}

/** SQL for the gallery column (or an empty list while the column does not exist yet). */
export const galleryCol = async () => ((await galleryReady()) ? 'c.gallery' : `'[]'::jsonb as gallery`);

export async function requireGallery() {
  if (!(await galleryReady())) throw bad('Extra images are not set up yet: run db/06_gallery.sql in the database once.', 'gallery_not_ready');
}
