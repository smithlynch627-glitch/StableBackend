import { q } from '../db.js';

/** Recompute cached stats for one collection (floor, best offer, counts, 24h volume). */
export async function refreshCollectionStats(address, db = { q }) {
  await db.q(
    `update collections c set
       floor_wei = (select min(price_wei) from orders o where o.collection = c.address and o.kind = 'listing' and o.status = 'active'),
       best_offer_wei = (select max(price_wei) from orders o where o.collection = c.address and o.kind in ('offer','collection_offer') and o.status = 'active'),
       listed_count = (select count(*) from orders o where o.collection = c.address and o.kind = 'listing' and o.status = 'active'),
       owners_count = (select count(distinct owner) from tokens t where t.collection = c.address and t.owner is not null
                       and t.owner <> '0x0000000000000000000000000000000000000000'),
       total_supply = (select count(*) from tokens t where t.collection = c.address and t.owner is not null
                       and t.owner <> '0x0000000000000000000000000000000000000000'),
       volume_24h_wei = coalesce((select sum(price_wei) from activity a where a.collection = c.address and a.type = 'sale'
                                  and a.created_at > now() - interval '24 hours'), 0)
     where c.address = $1`,
    [address],
  );
}

/** Mark expired orders and refresh every affected collection. */
export async function expireOrders() {
  const { rows } = await q(
    `with u as (update orders set status = 'expired', updated_at = now()
       where status = 'active' and end_time < now() returning collection)
     select distinct collection from u`,
  );
  for (const r of rows) await refreshCollectionStats(r.collection);
  return rows.length;
}

export async function refreshAllStats() {
  const { rows } = await q(`select address from collections`);
  for (const r of rows) await refreshCollectionStats(r.address);
}
