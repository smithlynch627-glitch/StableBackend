// Website content edited in the admin panel (stored in app.settings): the site logo, the GIWA COWS artwork,
// and the Terms of Use / Privacy Policy text. The website reads them at start-up, so no redeploy is needed.
import { createHash } from 'node:crypto';
import { bad } from './http.js';
import { getSettings, setSettings } from './settings.js';

export const MAX_ART = 60;
export const LEGAL_KINDS = ['terms', 'privacy'];
export const LEGAL_LANGS = ['en', 'ko'];
export const MAX_LEGAL = 60_000;

// Images shown to every visitor: https links, or ipfs:// links the website opens through a gateway.
const IMG = /^(https:\/\/[^\s"'<>\\]{4,500}|ipfs:\/\/[A-Za-z0-9._\-/]{10,500})$/;
const okImage = (v) => typeof v === 'string' && IMG.test(v);

export function cleanImage(v, name) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!IMG.test(s)) throw bad(`${name}: use an https:// or ipfs:// link to the image`);
  if (s.startsWith('https://')) { try { new URL(s); } catch { throw bad(`${name}: this link is not valid`); } }
  return s;
}

export function cleanImageList(list, name) {
  if (list === null || list === undefined) return null;
  if (!Array.isArray(list)) throw bad(`${name} must be a list of links`);
  const out = [];
  for (const [i, v] of list.entries()) {
    const s = cleanImage(v, `${name} #${i + 1}`);
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > MAX_ART) throw bad(`${name}: at most ${MAX_ART} images`);
  return out.length ? out : null;
}

/** Only the values the admin set; the website keeps its built-in defaults for the rest. */
export async function publicBranding() {
  const s = await getSettings();
  const art = Array.isArray(s['cows.images']) ? s['cows.images'].filter(okImage).slice(0, MAX_ART) : [];
  return {
    logo: okImage(s['brand.logo']) ? s['brand.logo'] : null,
    cowsLogo: okImage(s['cows.logo']) ? s['cows.logo'] : null,
    cowsBanner: okImage(s['cows.banner']) ? s['cows.banner'] : null,
    cowsImages: art.length ? art : null,
  };
}

export async function saveBranding(b, actor) {
  const values = {};
  if ('logo' in b) values['brand.logo'] = cleanImage(b.logo, 'Site logo');
  if ('cowsLogo' in b) values['cows.logo'] = cleanImage(b.cowsLogo, 'GIWA COWS logo');
  if ('cowsBanner' in b) values['cows.banner'] = cleanImage(b.cowsBanner, 'GIWA COWS banner');
  if ('cowsImages' in b) values['cows.images'] = cleanImageList(b.cowsImages, 'GIWA COWS artwork');
  if (!Object.keys(values).length) throw bad('Nothing to update');
  await setSettings(values, actor);
  return values;
}

/** Plain text (a small Markdown subset, rendered safely on the website): never HTML. */
export function cleanLegalText(v) {
  const s = String(v ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .trim();
  if (s.length > MAX_LEGAL) throw bad(`The text is too long (${s.length.toLocaleString()} of ${MAX_LEGAL.toLocaleString()} characters)`);
  return s;
}

const legalKey = (kind, lang) => {
  if (!LEGAL_KINDS.includes(kind) || !LEGAL_LANGS.includes(lang)) throw bad('Unknown page');
  return `legal.${kind}.${lang}`;
};

export async function legalDoc(kind, lang) {
  const s = await getSettings();
  const d = s[legalKey(kind, lang)];
  return d && typeof d.text === 'string' && d.text ? { text: d.text, updated: d.updated || null } : null;
}

/** Saves one page in one language (empty text = back to the built-in text). Returns what the audit log keeps. */
export async function saveLegal(kind, lang, text, actor) {
  const key = legalKey(kind, lang);
  const clean = cleanLegalText(text);
  if (!clean) {
    await setSettings({ [key]: null }, actor);
    return { page: key, reset: true };
  }
  const updated = new Date().toISOString().slice(0, 10);
  await setSettings({ [key]: { text: clean, updated } }, actor);
  return { page: key, chars: clean.length, sha256: createHash('sha256').update(clean).digest('hex').slice(0, 16), updated };
}

export async function siteContent() {
  const legal = {};
  for (const kind of LEGAL_KINDS) {
    legal[kind] = {};
    for (const lang of LEGAL_LANGS) legal[kind][lang] = await legalDoc(kind, lang);
  }
  return { branding: await publicBranding(), legal, limits: { art: MAX_ART, legal: MAX_LEGAL } };
}
