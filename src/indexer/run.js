// Indexer worker. Deploy as a second Railway service with start command: npm run indexer
import { config, contractsReady } from '../config.js';
import { one, q } from '../db.js';
import { loadNetwork } from '../lib/network.js';
import { getProvider } from '../lib/chain.js';
import { expireOrders, refreshAllStats, takeSnapshots } from '../lib/stats.js';
import { applyCollectionFlags, knownCollections, processLogs } from './core.js';

const CHUNK = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const latest = await provider.getBlockNumber();
  let from = (await getCursor()) + 1;
  while (from <= latest) {
    const to = Math.min(latest, from + CHUNK - 1);
    const before = await knownCollections();
    const addresses = [config.market, config.factory, ...before].filter(Boolean);
    for (let i = 0; i < addresses.length; i += 500) {
      const logs = await provider.getLogs({ address: addresses.slice(i, i + 500), fromBlock: from, toBlock: to });
      if (logs.length) await processLogs(logs);
    }
    // Collections created in this range were unknown when the logs above were fetched, so their own events
    // (mints, transfers, phase changes) in the same range are read now. Processing is idempotent.
    const added = [...(await knownCollections())].filter((a) => !before.has(a));
    for (let i = 0; i < added.length; i += 500) {
      const logs = await provider.getLogs({ address: added.slice(i, i + 500), fromBlock: from, toBlock: to });
      if (logs.length) await processLogs(logs);
    }
    await setCursor(to);
    from = to + 1;
  }
  return latest;
}

async function main() {
  await loadNetwork();
  console.log(`[indexer] ${config.networkName} (chain ${config.chainId}), market ${config.market || '-'}, factory ${config.factory || '-'}`);
  await applyCollectionFlags().catch(() => {});
  let lastMaintenance = 0;
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
        lastMaintenance = Date.now();
        if (expired) console.log(`[indexer] expired ${expired} orders`);
      }
    } catch (e) {
      console.error('[indexer]', e.shortMessage || e.message);
    }
    await sleep(config.indexerPollMs);
  }
}

main();
