import { Router } from 'express';
import { many, one } from '../db.js';
import { ah, notFound, tokenIdParam } from '../lib/http.js';
import { BEST_LISTING_JOIN, TOKEN_COLS, loadCollection, traitCounts } from '../lib/queries.js';

const r = Router();

r.get('/:collection/:tokenId', ah(async (req, res) => {
  const col = await loadCollection(req.params.collection);
  const tokenId = tokenIdParam(req.params.tokenId);
  const token = await one(
    `select ${TOKEN_COLS} from tokens t ${BEST_LISTING_JOIN} where t.collection = $1 and t.token_id = $2`,
    [col.address, tokenId],
  );
  if (!token || !token.owner) throw notFound('Item not found');
  const [offers, traits, ranked] = await Promise.all([
    many(
      `select hash, kind, token_id::text as token_id, maker, price_wei, currency, end_time, created_at
       from orders where collection = $1 and status = 'active'
         and ((kind = 'offer' and token_id = $2) or kind = 'collection_offer')
       order by price_wei desc limit 50`,
      [col.address, tokenId],
    ),
    traitCounts(col.address),
    one(`select count(*)::int as n from tokens where collection = $1 and rarity_rank is not null`, [col.address]),
  ]);
  const countOf = (type, value) => traits.find((t) => t.trait_type === type)?.values.find((v) => v.value === value)?.count ?? 0;
  const attributes = (token.attributes || []).map((a) => ({ ...a, count: countOf(a.trait_type, String(a.value)) }));
  // rarity_of: how many items have a rank (all revealed items), so "rank 22 of N" and its colour use the same N.
  res.json({ token: { ...token, attributes, rarity_of: ranked.n || null }, collection: col, offers });
}));

export default r;
