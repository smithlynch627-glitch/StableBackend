// Deletes the ACTIVE network's marketplace data (keeps users, admins, tickets). The indexer rebuilds it.
import { getPool, one } from '../src/db.js';

const n = await one(`select chain_id from app.networks where is_active`);
if (!n) throw new Error('No active network');
const s = `chain_${n.chain_id}`;
await getPool().query(`truncate ${s}.collections, ${s}.tokens, ${s}.orders, ${s}.activity, ${s}.drops, ${s}.allowlists, ${s}.fee_ledger, ${s}.indexer_state restart identity cascade`);
console.log(`Cleared ${s}. The indexer will rebuild it from the network start block.`);
await getPool().end();
