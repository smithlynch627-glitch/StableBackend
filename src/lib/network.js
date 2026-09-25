// Active network = one row in app.networks. The admin panel switches it; every API instance and the
// indexer pick the change up within a few seconds, and each chain keeps its data in its own schema.
import { config } from '../config.js';
import { many, one, q, useChain } from '../db.js';
import { resetChainClients } from './chain.js';

// Snapshot of the network settings from .env, taken before any database values are applied.
const ENV = {
  chainId: config.chainId,
  hasEnv: Boolean(process.env.RPC_URL || process.env.MARKET_ADDRESS),
  row: {
    rpc_url: config.rpcUrl,
    public_rpc_url: config.publicRpcUrl,
    explorer_url: config.explorerUrl,
    explorer_api_url: config.explorerApiUrl || null,
    market_address: config.market || null,
    factory_address: config.factory || null,
    fee_vault_address: config.feeVault || null,
    weth_address: config.weth,
    official_collection: config.officialCollection || null,
    start_block: config.indexerStartBlock,
  },
};

let loadedKey = null;
let loadedAt = null;
const listeners = new Set();
export const onNetworkChange = (fn) => listeners.add(fn);

function apply(n) {
  Object.assign(config, {
    networkKey: n.key,
    networkName: n.name,
    isTestnet: n.is_testnet,
    chainId: n.chain_id,
    rpcUrl: n.rpc_url,
    publicRpcUrl: n.public_rpc_url || n.rpc_url,
    explorerUrl: n.explorer_url,
    explorerApiUrl: n.explorer_api_url || '',
    market: n.market_address || '',
    factory: n.factory_address || '',
    feeVault: n.fee_vault_address || '',
    weth: n.weth_address,
    officialCollection: n.official_collection || '',
    indexerStartBlock: Number(n.start_block || 0),
  });
  resetChainClients();
}

/** Loads the active network (creating the first one from env if the table is empty). */
export async function loadNetwork() {
  let n = await one(`select * from app.networks where is_active`);
  if (!n) {
    n = await one(
      `insert into app.networks (key, chain_id, name, rpc_url, public_rpc_url, explorer_url, explorer_api_url, is_testnet,
         market_address, factory_address, fee_vault_address, weth_address, official_collection, start_block, is_active, updated_by)
       values ('giwa-sepolia',$1,'GIWA Sepolia',$2,$3,$4,$5,true,nullif($6,''),nullif($7,''),nullif($8,''),$9,nullif($10,''),$11,true,'env')
       on conflict (key) do update set is_active = true returning *`,
      [config.chainId, config.rpcUrl, config.publicRpcUrl, config.explorerUrl, config.explorerApiUrl, config.market, config.factory,
        config.feeVault, config.weth, config.officialCollection, config.indexerStartBlock],
    );
  } else if ((!n.updated_by || n.updated_by === 'env') && n.chain_id === ENV.chainId && ENV.hasEnv) {
    // .env stays in control of this network until someone edits it in Admin → Network.
    const changed = Object.entries(ENV.row).filter(([k, v]) => String(n[k] ?? '') !== String(v ?? ''));
    if (changed.length) {
      n = await one(
        `update app.networks set ${changed.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_by = 'env', updated_at = now()
         where key = $1 returning *`,
        [n.key, ...changed.map(([, v]) => v)],
      );
      console.log(`[network] applied from .env: ${changed.map(([k]) => k).join(', ')}`);
    }
  }
  await q(`select app.ensure_chain_schema($1)`, [n.chain_id]);
  await useChain(n.chain_id);
  apply(n);
  const changed = loadedKey !== null && (loadedKey !== n.key || String(loadedAt) !== String(n.updated_at));
  loadedKey = n.key;
  loadedAt = n.updated_at;
  if (changed) for (const fn of listeners) await fn(n);
  return n;
}

/** Re-reads the active network every `ms`; applies it when an admin changed or switched it. */
export function watchNetwork(ms = 10_000) {
  setInterval(async () => {
    try {
      const n = await one(`select key, updated_at from app.networks where is_active`);
      if (n && (n.key !== loadedKey || String(n.updated_at) !== String(loadedAt))) {
        await loadNetwork();
        console.log(`[network] now on ${config.networkName} (chain ${config.chainId})`);
      }
    } catch (e) {
      console.warn('[network]', e.message);
    }
  }, ms).unref();
}

export const listNetworks = () => many(`select * from app.networks order by is_active desc, key`);
