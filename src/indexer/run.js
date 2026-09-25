// Indexer worker. Deploy as a second Railway service with start command: npm run indexer
import { config, contractsReady } from '../config.js';
import { one, q } from '../db.js';
import { loadNetwork } from '../lib/network.js';
import { getProvider } from '../lib/chain.js';
import { expireOrders, refreshAllStats } from '../lib/stats.js';
import { applyCollectionFlags, knownCollections, processLogs } from './core.js';

const CHUNK = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCursor() {
  const row = await one(`select value from indexer_state where key = 'last_block'`);
  return row ? Number(row.value) : config.indexerStartBlock - 1;
}
const setCursor = (n) =>
  q(`insert into indexer_state (key, value) values ('last_block', $1) on conflict (key) do update set value = excluded.value`, [String(n)]);

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
      await tick();
      if (Date.now() - lastMaintenance > 60_000) {
        const expired = await expireOrders();
        await refreshAllStats();
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
