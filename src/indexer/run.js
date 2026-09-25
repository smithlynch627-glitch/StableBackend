// Indexer worker. Deploy as a second Railway service with start command: npm run indexer
import { config, contractsReady } from '../config.js';
import { many, one, q } from '../db.js';
import { loadNetwork } from '../lib/network.js';
import { collectionContract, getProvider } from '../lib/chain.js';
import { expireOrders, refreshAllStats, takeSnapshots } from '../lib/stats.js';
import { applyCollectionFlags, backfillMetadata, blockTime, knownCollections, processLogs, repairRawCidImages } from './core.js';

const CHUNK = 2000;
// The public RPC is load-balanced: the node that answers getLogs can be a few blocks behind the node that
// reported the latest block, and then returns nothing for blocks it doesn't have yet. So the indexer stays
// CONFIRMATIONS blocks behind the head and re-reads the last OVERLAP blocks every round (already-processed
// logs are skipped). A periodic check against the contracts repairs anything that still slipped through.
const CONFIRMATIONS = Number(process.env.INDEXER_CONFIRMATIONS ?? 2);
const OVERLAP = Number(process.env.INDEXER_OVERLAP ?? 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = new Map(); // "<tx>:<logIndex>" → true, most recent ~30k logs
function freshLogs(logs) {
  const newTx = new Set(logs.filter((l) => !seen.has(`${l.transactionHash}:${l.index}`)).map((l) => l.transactionHash));
  // Keep every log of a transaction that has anything new (sales need the transfer and the fill together).
  return logs.filter((l) => newTx.has(l.transactionHash));
}
function markSeen(logs) {
  for (const l of logs) seen.set(`${l.transactionHash}:${l.index}`, true);
  while (seen.size > 30_000) seen.delete(seen.keys().next().value);
}
async function readLogs(provider, addresses, fromBlock, toBlock) {
  for (let i = 0; i < addresses.length; i += 500) {
    const logs = await provider.getLogs({ address: addresses.slice(i, i + 500), fromBlock, toBlock });
    const fresh = freshLogs(logs);
    if (fresh.length) await processLogs(fresh);
    markSeen(logs);
  }
}

async function getCursor() {
  const row = await one(`select value from indexer_state where key = 'last_block'`);
  return row ? Number(row.value) : config.indexerStartBlock - 1;
}
const setCursor = (n) =>
  q(`insert into indexer_state (key, value) values ('last_block', $1) on conflict (key) do update set value = excluded.value`, [String(n)]);

/**
 * After a contract upgrade (new marketplace / factory addresses):
 *  - listings and offers signed for the old marketplace can no longer be filled, so they are retired;
 *  - the indexer re-reads from the network's start block, so nothing created on the new contracts is missed.
 *    Re-reading is safe: every write is idempotent (activity and fees are keyed by transaction log).
 */
async function checkContractsChanged() {
  const key = `${config.market}|${config.factory}`;
  const row = await one(`select value from indexer_state where key = 'contracts'`);
  if (row?.value === key) return;
  if (row) {
    const [oldMarket] = row.value.split('|');
    if (oldMarket !== config.market) {
      const n = await q(`update orders set status = 'inactive', updated_at = now() where status = 'active'`);
      console.log(`[indexer] marketplace changed: retired ${n.rowCount} orders signed for the previous marketplace`);
    }
    const cursor = await getCursor();
    if (config.indexerStartBlock > 0 && cursor >= config.indexerStartBlock) {
      await setCursor(config.indexerStartBlock - 1);
      console.log(`[indexer] contracts changed: re-reading from block ${config.indexerStartBlock}`);
    }
    await refreshAllStats();
  }
  await q(`insert into indexer_state (key, value) values ('contracts', $1) on conflict (key) do update set value = excluded.value`, [key]);
}

async function tick() {
  const provider = getProvider();
  const latest = (await provider.getBlockNumber()) - CONFIRMATIONS;
  const cursor = await getCursor();
  let from = Math.max(cursor + 1 - OVERLAP, config.indexerStartBlock || 0, 0);
  while (from <= latest) {
    const to = Math.min(latest, from + CHUNK - 1);
    const before = await knownCollections();
    await readLogs(provider, [config.market, config.factory, ...before].filter(Boolean), from, to);
    // Collections created in this range were unknown when the logs above were fetched, so their own events
    // (mints, transfers, phase changes) in the same range are read now. Processing is idempotent.
    const added = [...(await knownCollections())].filter((a) => !before.has(a));
    if (added.length) await readLogs(provider, added, from, to);
    if (to > cursor) await setCursor(to);
    from = to + 1;
  }
  return latest;
}

/** First block at or after a time (binary search on block headers). */
async function blockAt(ms, latest) {
  let lo = 0; // collections from before a contract upgrade can be older than INDEXER_START_BLOCK
  let hi = latest;
  if ((await blockTime(lo)).getTime() >= ms) return lo;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTime(mid)).getTime() < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Safety net: for launchpad collections, the number of tokens on-chain must match the database.
 * If the contract has more (events were missed), that collection's history is read again.
 * One collection is repaired per round so the live indexing never waits long.
 */
async function reconcile() {
  const cols = await many(`select address, created_at from collections where not is_external order by created_at desc limit 300`);
  const counts = new Map((await many(`select collection, count(*)::int as n from tokens group by collection`)).map((r) => [r.collection, r.n]));
  for (let i = 0; i < cols.length; i += 6) {
    const part = cols.slice(i, i + 6);
    const onchain = await Promise.all(part.map((c) => collectionContract(c.address).totalSupply().then(Number).catch(() => -1)));
    const idx = part.findIndex((c, k) => onchain[k] > (counts.get(c.address) || 0));
    if (idx === -1) continue;
    const c = part[idx];
    const provider = getProvider();
    const cursor = await getCursor();
    const start = await blockAt(new Date(c.created_at).getTime() - 10 * 60_000, cursor);
    console.log(`[indexer] ${c.address}: ${onchain[idx]} on-chain, ${counts.get(c.address) || 0} indexed. Re-reading from block ${start}.`);
    for (let from = start; from <= cursor; from += CHUNK) {
      const to = Math.min(cursor, from + CHUNK - 1);
      // The marketplace is read too, so sales in that history are recognised as sales.
      const logs = await provider.getLogs({ address: [c.address, config.market].filter(Boolean), fromBlock: from, toBlock: to });
      if (logs.length) await processLogs(logs);
    }
    const after = (await one(`select count(*)::int as n from tokens where collection = $1`, [c.address])).n;
    console.log(`[indexer] ${c.address}: ${after} tokens indexed after repair.`);
    return;
  }
}

async function main() {
  await loadNetwork();
  console.log(`[indexer] ${config.networkName} (chain ${config.chainId}), market ${config.market || '-'}, factory ${config.factory || '-'}`);
  await applyCollectionFlags().catch(() => {});
  await repairRawCidImages().catch((e) => console.warn('[metadata]', e.message));
  let lastMaintenance = 0;
  let lastReconcile = Date.now() - 100_000; // first check ~20 s after start
  let lastNetworkCheck = Date.now();
  let activeKey = `${config.networkKey}:${config.chainId}`;
  for (;;) {
    try {
      if (Date.now() - lastNetworkCheck > 10_000) {
        await loadNetwork(); // picks up an admin network switch or new contract addresses
        lastNetworkCheck = Date.now();
        const key = `${config.networkKey}:${config.chainId}`;
        if (key !== activeKey) {
          console.log(`[indexer] switched to ${config.networkName} (chain ${config.chainId})`);
          activeKey = key;
        }
      }
      if (!contractsReady()) {
        await sleep(config.indexerPollMs);
        continue;
      }
      await checkContractsChanged();
      await tick();
      if (Date.now() - lastMaintenance > 60_000) {
        const expired = await expireOrders();
        await refreshAllStats();
        await takeSnapshots().catch((e) => console.warn('[snapshots]', e.message));
        await backfillMetadata().catch((e) => console.warn('[metadata]', e.message));
        lastMaintenance = Date.now();
        if (expired) console.log(`[indexer] expired ${expired} orders`);
      }
      if (Date.now() - lastReconcile > 120_000) {
        lastReconcile = Date.now();
        await reconcile().catch((e) => console.warn('[reconcile]', e.shortMessage || e.message));
      }
    } catch (e) {
      console.error('[indexer]', e.shortMessage || e.message);
    }
    await sleep(config.indexerPollMs);
  }
}

main();
