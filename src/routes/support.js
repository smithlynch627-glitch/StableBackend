// User support tickets. Contact details are encrypted before storage (AES-256-GCM).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { many, one, q } from '../db.js';
import { ah, bad, notFound } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { encrypt } from '../lib/crypto.js';

const r = Router();
r.use(requireAuth);
const createLimit = rateLimit({ windowMs: 3600_000, limit: 10, keyGenerator: (req) => req.user, standardHeaders: 'draft-7', legacyHeaders: false });
const CATEGORIES = ['general', 'mint', 'trade', 'listing', 'offer', 'collection', 'wallet', 'bug', 'report', 'other'];
const ref = () => `ST-${randomBytes(4).toString('hex').toUpperCase()}`;

r.post('/', createLimit, ah(async (req, res) => {
  const b = req.body || {};
  const category = CATEGORIES.includes(b.category) ? b.category : 'general';
  const subject = String(b.subject || '').trim();
  const message = String(b.message || '').trim();
  if (subject.length < 3 || subject.length > 140) throw bad('Subject must be 3-140 characters');
  if (message.length < 10 || message.length > 4000) throw bad('Message must be 10-4000 characters');
  const txHash = b.txHash && /^0x[0-9a-fA-F]{64}$/.test(b.txHash) ? b.txHash : null;
  const contact = String(b.contact || '').trim().slice(0, 200);
  const t = await one(
    `insert into app.support_tickets (ref, address, category, subject, contact_enc, chain_id, collection, token_id, tx_hash, priority)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, ref`,
    [ref(), req.user, category, subject, contact ? encrypt(contact) : null, config.chainId,
      b.collection ? String(b.collection).toLowerCase().slice(0, 64) : null, b.tokenId ? String(b.tokenId).slice(0, 80) : null, txHash,
      category === 'report' || category === 'wallet' ? 'high' : 'normal'],
  );
  await q(`insert into app.ticket_messages (ticket_id, author, body) values ($1,$2,$3)`, [t.id, req.user, message]);
  res.json({ ticket: t });
}));

r.get('/mine', ah(async (req, res) => {
  res.json({
    tickets: await many(
      `select id, ref, category, subject, status, created_at, last_message_at from app.support_tickets where address = $1 order by last_message_at desc limit 50`,
      [req.user],
    ),
  });
}));

r.get('/:id', ah(async (req, res) => {
  const t = await one(
    `select id, ref, category, subject, status, collection, token_id, tx_hash, created_at from app.support_tickets where id = $1 and address = $2`,
    [String(req.params.id), req.user],
  ).catch(() => null);
  if (!t) throw notFound('Ticket not found');
  const messages = await many(`select id, is_staff, body, created_at from app.ticket_messages where ticket_id = $1 order by id`, [t.id]);
  res.json({ ticket: t, messages });
}));

r.post('/:id/reply', createLimit, ah(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > 4000) throw bad('Write a message (max 4000 characters)');
  const t = await one(
    `update app.support_tickets set status = 'open', updated_at = now(), last_message_at = now()
     where id = $1 and address = $2 and status <> 'closed' returning id`,
    [String(req.params.id), req.user],
  ).catch(() => null);
  if (!t) throw notFound('Ticket not found or closed');
  await q(`insert into app.ticket_messages (ticket_id, author, body) values ($1,$2,$3)`, [t.id, req.user, body]);
  res.json({ ok: true });
}));

export default r;
