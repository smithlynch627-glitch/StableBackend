// AES-256-GCM field encryption for sensitive data at rest (e.g. support contact details).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

function key() {
  const raw = config.encryptionKey;
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : createHash('sha256').update(raw).digest();
}

export function encrypt(text) {
  const k = key();
  if (!k || !text) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function decrypt(payload) {
  const k = key();
  if (!k || !payload?.startsWith('v1:')) return null;
  try {
    const b = Buffer.from(payload.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
