// Site settings stored in app.settings (edited in the admin panel), cached briefly for public reads.
import { many, q } from '../db.js';

const cache = { at: 0, data: {} };
export const SETTING_KEYS = ['social.x', 'social.discord', 'social.telegram', 'social.website'];

export async function getSettings() {
  if (Date.now() - cache.at < 30_000) return cache.data;
  try {
    const rows = await many(`select key, value from app.settings`);
    cache.data = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cache.at = Date.now();
  } catch {
    // table missing on an old schema: behave as empty
  }
  return cache.data;
}

export async function setSettings(values, actor) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === '') await q(`delete from app.settings where key = $1`, [key]);
    else
      await q(
        `insert into app.settings (key, value, updated_by) values ($1,$2,$3)
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), actor],
      );
  }
  cache.at = 0;
}

export async function publicSocials() {
  const s = await getSettings();
  return { x: s['social.x'] || null, discord: s['social.discord'] || null, telegram: s['social.telegram'] || null, website: s['social.website'] || null };
}
