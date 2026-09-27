// On-chain history for the admin panel: FeeVault withdrawals and everything the Safe executed (also actions done
// outside the panel, e.g. with safe-tx.ps1). Logs are read in block ranges that adapt to what the RPC accepts,
// saved to app.treasury_events, and the scan resumes where it stopped (app.treasury_cursor).
import { Interface } from 'ethers';
import { config } from '../config.js';
import { many, one, q } from '../db.js';
import { getProvider } from './chain.js';
import { currentSafe, decodeAdditionalInfo, safeIface } from './safe.js';

const vaultIface = new Interface([
  'event EthWithdrawn(address indexed to, uint256 amount)',
  'event TokenWithdrawn(address indexed token, address indexed to, uint256 amount)',
]);
const VAULT_EVENTS = ['EthWithdrawn', 'TokenWithdrawn'];
const SAFE_EVENTS = ['SafeMultiSigTransaction', 'ExecutionSuccess', 'ExecutionFailure', 'AddedOwner', 'RemovedOwner', 'ChangedThreshold',
  'EnabledModule', 'DisabledModule', 'ChangedGuard', 'ChangedFallbackHandler'];
const TOPICS = [...VAULT_EVENTS.map((n) => vaultIface.getEvent(n).topicHash), ...SAFE_EVENTS.map((n) => safeIface.getEvent(n).topicHash)];

const MIN_STEP = 500;
const MAX_STEP = 200_000;
const LAG = 3; // the public RPC is load-balanced; stay a few blocks behind the newest one
let running = null;
let step = 20_000;
let lastError = null;
const lc = (a) => String(a || '').toLowerCase();
const plain = (v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? lc(v) : v);

async function scope() {
  const safe = await currentSafe().catch(() => null);
  const addresses = [lc(config.feeVault), safe].filter(Boolean).sort();
  return { safe, addresses, key: addresses.join(',') };
}

function parse(log) {
  const iface = VAULT_EVENTS.some((n) => vaultIface.getEvent(n).topicHash === log.topics[0]) ? vaultIface : safeIface;
  const ev = iface.parseLog(log);
  if (!ev) return null;
  const args = {};
  ev.fragment.inputs.forEach((inp, i) => {
    if (inp.name === 'signatures') return; // not needed, and large
    args[inp.name] = plain(ev.args[i]);
  });
  if (ev.name === 'SafeMultiSigTransaction') Object.assign(args, decodeAdditionalInfo(args.additionalInfo)), delete args.additionalInfo;
  return { name: ev.name, args };
}

async function save(logs) {
  if (!logs.length) return;
  const p = getProvider();
  const times = new Map();
  for (const b of [...new Set(logs.map((l) => l.blockNumber))]) {
    const blk = await p.getBlock(b).catch(() => null);
    if (blk) times.set(b, new Date(blk.timestamp * 1000));
  }
  for (const log of logs) {
    const ev = parse(log);
    if (!ev) continue;
    await q(
      `insert into app.treasury_events (chain_id, address, block, log_index, tx_hash, name, args, block_time)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [config.chainId, lc(log.address), log.blockNumber, log.index, lc(log.transactionHash), ev.name, JSON.stringify(ev.args), times.get(log.blockNumber) || null],
    );
  }
}

async function run(budgetMs) {
  const s = await scope();
  if (!s.addresses.length) return;
  const row = await one(`select scanned_to from app.treasury_cursor where chain_id = $1 and scope = $2`, [config.chainId, s.key]);
  let from = row ? Number(row.scanned_to) + 1 : Math.max(0, Number(config.indexerStartBlock || 0));
  const head = (await getProvider().getBlockNumber()) - LAG;
  const deadline = Date.now() + budgetMs;
  while (from <= head && Date.now() < deadline) {
    const to = Math.min(head, from + step - 1);
    let logs;
    try {
      logs = await getProvider().getLogs({ address: s.addresses, topics: [TOPICS], fromBlock: from, toBlock: to });
    } catch (e) {
      if (step > MIN_STEP) {
        step = Math.max(MIN_STEP, Math.floor(step / 4)); // the RPC refused the range: try a smaller one
        continue;
      }
      throw e;
    }
    await save(logs);
    await q(
      `insert into app.treasury_cursor (chain_id, scope, scanned_to) values ($1,$2,$3)
       on conflict (chain_id, scope) do update set scanned_to = excluded.scanned_to, updated_at = now()`,
      [config.chainId, s.key, to],
    );
    from = to + 1;
    step = Math.min(MAX_STEP, step * 2);
  }
}

/** Scans new blocks (in the background). Waits at most `waitMs` so API responses stay fast. */
export async function refreshTreasury(waitMs = 2500) {
  if (!running) {
    running = run(25_000)
      .then(() => { lastError = null; })
      .catch((e) => { lastError = (e.shortMessage || e.message || 'scan failed').slice(0, 200); console.warn('[treasury]', lastError); })
      .finally(() => { running = null; });
  }
  await Promise.race([running, new Promise((r) => setTimeout(r, waitMs))]);
  return scanStatus();
}

export async function scanStatus() {
  const s = await scope();
  const row = await one(`select scanned_to from app.treasury_cursor where chain_id = $1 and scope = $2`, [config.chainId, s.key]);
  const head = await getProvider().getBlockNumber().catch(() => null);
  const start = Math.max(0, Number(config.indexerStartBlock || 0));
  const scannedTo = row ? Number(row.scanned_to) : start - 1;
  const done = head !== null && scannedTo >= head - LAG - 5;
  const total = head !== null ? Math.max(1, head - start) : 1;
  return { startBlock: start, scannedTo, head, done, running: !!running, progress: Math.min(1, Math.max(0, (scannedTo - start) / total)), error: lastError };
}

export async function vaultWithdrawals(limit = 100) {
  return many(
    `select tx_hash, block, log_index, name, args, block_time from app.treasury_events
     where chain_id = $1 and address = $2 and name in ('EthWithdrawn','TokenWithdrawn') order by block desc, log_index desc limit $3`,
    [config.chainId, lc(config.feeVault), limit],
  );
}

/** Executed Safe transactions (with success/failure) and owner/module changes, newest first. */
export async function safeHistory(safe, limit = 100) {
  if (!safe) return [];
  const rows = await many(
    `select tx_hash, block, log_index, name, args, block_time from app.treasury_events
     where chain_id = $1 and address = $2 order by block desc, log_index desc limit $3`,
    [config.chainId, safe, limit * 3],
  );
  const byTx = new Map();
  for (const r of rows) {
    if (!byTx.has(r.tx_hash)) byTx.set(r.tx_hash, []);
    byTx.get(r.tx_hash).push(r);
  }
  const out = [];
  for (const [tx, list] of byTx) {
    const multi = list.find((x) => x.name === 'SafeMultiSigTransaction');
    const result = list.find((x) => x.name === 'ExecutionSuccess' || x.name === 'ExecutionFailure');
    const changes = list.filter((x) => !['SafeMultiSigTransaction', 'ExecutionSuccess', 'ExecutionFailure'].includes(x.name)).map((x) => ({ name: x.name, args: x.args }));
    out.push({
      tx_hash: tx,
      block: list[0].block,
      time: list[0].block_time,
      safe_tx_hash: result?.args?.txHash || null,
      success: result ? result.name === 'ExecutionSuccess' : null,
      to: multi?.args?.to || null,
      value: multi?.args?.value || '0',
      data: multi?.args?.data || null,
      nonce: multi?.args?.nonce ?? null,
      executor: multi?.args?.sender || null,
      changes,
    });
  }
  return out.slice(0, limit);
}

/** Safe nonce → the safeTxHash that used it (from SafeMultiSigTransaction + ExecutionSuccess/Failure in the same tx). */
export async function executedNonces(safe) {
  if (!safe) return new Map();
  const rows = await many(
    `select (m.args->>'nonce')::bigint as nonce, e.args->>'txHash' as h, m.tx_hash
     from app.treasury_events m
     join app.treasury_events e on e.chain_id = m.chain_id and e.tx_hash = m.tx_hash and e.address = m.address and e.name in ('ExecutionSuccess','ExecutionFailure')
     where m.chain_id = $1 and m.address = $2 and m.name = 'SafeMultiSigTransaction' and m.args->>'nonce' is not null`,
    [config.chainId, safe],
  );
  return new Map(rows.map((r) => [Number(r.nonce), { safe_tx_hash: lc(r.h), tx_hash: r.tx_hash }]));
}

/** safeTxHash → { tx_hash, success, executor, time } for executed Safe transactions. */
export async function executedHashes(safe) {
  if (!safe) return new Map();
  const rows = await many(
    `select e.tx_hash, e.name, e.args->>'txHash' as h, e.block_time,
       (select m.args->>'sender' from app.treasury_events m where m.chain_id = e.chain_id and m.tx_hash = e.tx_hash and m.name = 'SafeMultiSigTransaction' limit 1) as executor
     from app.treasury_events e where e.chain_id = $1 and e.address = $2 and e.name in ('ExecutionSuccess','ExecutionFailure')`,
    [config.chainId, safe],
  );
  return new Map(rows.map((r) => [lc(r.h), { tx_hash: r.tx_hash, success: r.name === 'ExecutionSuccess', executor: r.executor, time: r.block_time }]));
}

