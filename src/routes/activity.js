import { Router } from 'express';
import { many } from '../db.js';
import { ah, clampInt } from '../lib/http.js';
import { ACTIVITY_SELECT, loadCollection } from '../lib/queries.js';

const r = Router();
const TYPES = new Set(['mint', 'list', 'delist', 'sale', 'transfer', 'offer', 'offer_cancel', 'collection_offer']);

r.get('/', ah(async (req, res) => {
  const params = [];
  const where = ['not c.hidden'];
  const add = (v) => (params.push(v), `$${params.length}`);
  if (req.query.collection) where.push(`a.collection = ${add((await loadCollection(req.query.collection)).address)}`);
  if (req.query.token) where.push(`a.token_id = ${add(String(req.query.token).replace(/\D/g, '') || '0')}`);
  if (req.query.address) {
    const a = add(String(req.query.address).toLowerCase());
    where.push(`(a.from_addr = ${a} or a.to_addr = ${a})`);
  }
  const types = String(req.query.types || '').split(',').filter((t) => TYPES.has(t));
  if (types.length) where.push(`a.type = any(${add(types)})`);
  if (req.query.before) where.push(`a.id < ${add(clampInt(req.query.before, 0, Number.MAX_SAFE_INTEGER, 0))}`);
  const limit = clampInt(req.query.limit, 1, 100, 30);
  const rows = await many(
    `${ACTIVITY_SELECT} where ${where.join(' and ')} order by a.id desc limit ${limit}`,
    params,
  );
  res.json({ activity: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
}));

export default r;
