// Admin API: treasury (FeeVault + Safe balances, withdrawals) and Safe multisig proposals.
// Registered on the admin router, so every route already has: admin-site origin check, rate limit, signed session.
import { Contract } from 'ethers';
import { config } from '../config.js';
import { many, one, q, tx } from '../db.js';
import { ah, bad, clampInt, notFound } from '../lib/http.js';
import { audit, requireRole } from '../lib/admin.js';
import { getProvider } from '../lib/chain.js';
import {
  checkCall, currentSafe, guardianOf, managedContracts, marketOwner, OFFICIAL, proposalTargets, recoverSigner, safeContract,
  safeIface, safeState, safeTxHash,
} from '../lib/safe.js';
import { executedHashes, executedNonces, refreshTreasury, safeHistory, vaultWithdrawals } from '../lib/treasury.js';

const lc = (a) => String(a || '').toLowerCase();
const ADDR = /^0x[0-9a-f]{40}$/;
const erc20 = (a) => new Contract(a, ['function balanceOf(address) view returns (uint256)'], getProvider());

async function balancesOf(address) {
  const [eth, weth] = await Promise.all([getProvider().getBalance(address), erc20(config.weth).balanceOf(address).catch(() => 0n)]);
  return { eth: eth.toString(), weth: weth.toString() };
}

const KIND = {
  withdrawEth: 'withdraw', withdrawAllEth: 'withdraw', withdrawToken: 'withdraw', transfer: 'transfer', withdraw: 'transfer',
  setMarketFeeBps: 'fees', setPlatformFeeBps: 'fees', setFeeRecipient: 'fees', pause: 'pause', unpause: 'pause',
  setCollectionApproval: 'collection', setCollectionBlocked: 'collection', setFactory: 'factory', setGuardian: 'guardian',
  acceptOwnership: 'ownership', addOwnerWithThreshold: 'owners', removeOwner: 'owners', swapOwner: 'owners', changeThreshold: 'owners', cancel: 'cancel',
};

const PROPOSAL_COLS = `p.id, p.safe, p.to_address, p.value_wei::text as value_wei, p.data, p.nonce, p.safe_tx_hash, p.kind, p.label, p.status,
  p.created_by, p.created_at, p.executed_tx, p.executed_by, p.executed_at,
  coalesce((select json_agg(json_build_object('signer', s.signer, 'signature', s.signature, 'created_at', s.created_at) order by s.signer)
            from app.safe_signatures s where s.proposal_id = p.id), '[]') as signatures`;

/**
 * Pending proposals whose nonce the Safe already used: executed (their hash is on-chain) or replaced (another
 * transaction used that nonce). Nothing is marked replaced until that other transaction is actually found.
 */
async function reconcile(safe, onchainNonce) {
  const stale = await many(
    `select id, nonce, safe_tx_hash from app.safe_proposals where chain_id = $1 and safe = $2 and status = 'pending' and nonce < $3`,
    [config.chainId, safe, onchainNonce],
  );
  if (!stale.length) return;
  await refreshTreasury(3000).catch(() => undefined);
  const [byHash, byNonce] = await Promise.all([executedHashes(safe), executedNonces(safe)]);
  for (const p of stale) {
    const e = byHash.get(p.safe_tx_hash);
    if (e) {
      await q(
        `update app.safe_proposals set status = $2, executed_tx = $3, executed_by = $4, executed_at = $5, updated_at = now() where id = $1 and status = 'pending'`,
        [p.id, e.success ? 'executed' : 'failed', e.tx_hash, e.executor, e.time],
      );
    } else {
      const other = byNonce.get(Number(p.nonce));
      if (other && other.safe_tx_hash !== p.safe_tx_hash) {
        await q(`update app.safe_proposals set status = 'replaced', updated_at = now() where id = $1 and status = 'pending'`, [p.id]);
      }
    }
  }
}

/** One proposal change at a time per Safe (nonce assignment, discards, signatures). */
const lockSafe = (h, safe) => h.q(`select pg_advisory_xact_lock(hashtext($1))`, [`stable-safe:${config.chainId}:${safe}`]);
// Labels are free text from any admin: keep them on one line, without control or text-direction characters.
const cleanLabel = (v) => String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

function healthChecks(state, managed, guardian) {
  const n = state.owners.length;
  const c = [];
  c.push(state.threshold >= 2
    ? { id: 'threshold', ok: true, title: `${state.threshold} of ${n} signatures needed`, detail: 'One stolen key alone cannot move anything.' }
    : { id: 'threshold', ok: false, level: 'danger', title: 'Only 1 signature needed', detail: 'One stolen key can control everything. Raise the threshold to 2.' });
  c.push(state.threshold < n
    ? { id: 'spare', ok: true, title: 'A lost key can be replaced', detail: `${n - state.threshold} spare owner${n - state.threshold > 1 ? 's' : ''}: the others can still sign and swap the lost wallet.` }
    : { id: 'spare', ok: false, level: 'warning', title: 'No spare owner', detail: 'If one owner wallet is lost, the Safe is locked forever. Add an owner.' });
  c.push(state.modules && state.modules.length === 0
    ? { id: 'modules', ok: true, title: 'No modules', detail: 'Nothing can act for the Safe without owner signatures.' }
    : { id: 'modules', ok: false, level: 'danger', title: state.modules ? `${state.modules.length} module(s) enabled` : 'Modules could not be read', detail: 'A module can execute transactions without signatures. Remove it unless you added it on purpose.' });
  c.push(!state.guard || /^0x0{40}$/.test(state.guard)
    ? { id: 'guard', ok: true, title: 'No transaction guard', detail: 'Standard Safe behaviour.' }
    : { id: 'guard', ok: false, level: 'warning', title: 'A transaction guard is set', detail: `Guard ${state.guard} checks every transaction. Make sure you set it.` });
  c.push(state.fallbackHandler === OFFICIAL.fallbackHandler
    ? { id: 'fallback', ok: true, title: 'Official fallback handler', detail: 'Safe v1.3.0 CompatibilityFallbackHandler.' }
    : { id: 'fallback', ok: false, level: 'warning', title: 'Unknown fallback handler', detail: `${state.fallbackHandler || 'none'} is not the official handler.` });
  const notOwned = managed.filter((m) => !m.ownedBySafe);
  c.push(!notOwned.length
    ? { id: 'ownership', ok: true, title: 'Safe owns every STABLE contract', detail: managed.map((m) => m.name).join(', ') }
    : { id: 'ownership', ok: false, level: 'warning', title: `${notOwned.length} contract(s) not owned by the Safe`, detail: notOwned.map((m) => `${m.name}${m.pendingOwner === state.address ? ' (waiting for the Safe to accept)' : ''}`).join(', ') });
  c.push(guardian && !/^0x0{40}$/.test(guardian)
    ? { id: 'guardian', ok: true, title: 'Emergency pause wallet set', detail: `${guardian} can pause trading at once (it can't do anything else).` }
    : { id: 'guardian', ok: false, level: 'info', title: 'No emergency pause wallet', detail: 'Pausing then needs owner signatures, which takes longer in an emergency.' });
  return c;
}

export function treasuryRoutes(r) {
  // ── Multisig status ──────────────────────────────────────────────────────────
  r.get('/safe', requireRole('admin'), ah(async (_req, res) => {
    if (!config.market) return res.json({ ready: false });
    const safe = await currentSafe();
    const [managed, guardian] = await Promise.all([managedContracts(safe), guardianOf()]);
    if (!safe) return res.json({ ready: true, safe: null, owner: marketOwner(), managed, guardian });
    const [state, balances, scan] = await Promise.all([safeState(safe), balancesOf(safe), refreshTreasury(1500)]);
    const admins = await many(`select address, role from app.admins where address = any($1)`, [state.owners]);
    const roles = new Map(admins.map((a) => [a.address, a.role]));
    const owners = state.owners.map((a) => ({ address: a, panelRole: config.rootAdmins.includes(a) ? 'owner' : roles.get(a) || null }));
    res.json({
      ready: true, safe: { ...state, owners, balances }, managed, guardian, checks: healthChecks(state, managed, guardian),
      history: await safeHistory(safe, 60), scan,
    });
  }));

  // ── Treasury ─────────────────────────────────────────────────────────────────
  r.get('/funds', requireRole('admin'), ah(async (_req, res) => {
    if (!config.market || !config.feeVault) return res.json({ ready: false });
    const safe = await currentSafe();
    const [vault, safeBal, earnings, daily, scan] = await Promise.all([
      balancesOf(config.feeVault),
      safe ? balancesOf(safe) : null,
      one(`select coalesce(sum(amount_wei) filter (where source = 'mint'), 0) as mint_wei,
                  coalesce(sum(amount_wei) filter (where source = 'trade'), 0) as trade_wei,
                  coalesce(sum(amount_wei) filter (where created_at > now() - interval '30 days'), 0) as last30_wei
           from fee_ledger`),
      many(`with days as (select generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') as d),
                 f as (select date_trunc('day', created_at) as d, sum(amount_wei) as fees from fee_ledger
                       where created_at >= date_trunc('day', now()) - interval '29 days' group by 1)
            select to_char(days.d, 'YYYY-MM-DD') as day, coalesce(f.fees, 0)::text as value from days left join f on f.d = days.d order by days.d`),
      refreshTreasury(2000),
    ]);
    res.json({
      ready: true, weth: config.weth, vault: { address: config.feeVault, ...vault }, safe: safe ? { address: safe, ...safeBal } : null,
      earnings, daily, withdrawals: await vaultWithdrawals(100), scan,
    });
  }));

  // ── Proposals ────────────────────────────────────────────────────────────────
  r.get('/proposals', requireRole('admin'), ah(async (req, res) => {
    const safe = await currentSafe();
    if (!safe) return res.json({ safe: null, proposals: [] });
    const s = safeContract(safe);
    const [nonce, threshold, owners] = await Promise.all([s.nonce().then(Number), s.getThreshold().then(Number), s.getOwners().then((o) => o.map(lc))]);
    await reconcile(safe, nonce);
    const view = req.query.view === 'history' ? 'history' : 'queue';
    const rows = await many(
      view === 'queue'
        ? `select ${PROPOSAL_COLS} from app.safe_proposals p where p.chain_id = $1 and p.safe = $2 and p.status = 'pending' order by p.nonce, p.id limit 100`
        : `select ${PROPOSAL_COLS} from app.safe_proposals p where p.chain_id = $1 and p.safe = $2 and p.status <> 'pending' order by p.updated_at desc limit $3`,
      view === 'queue' ? [config.chainId, safe] : [config.chainId, safe, clampInt(req.query.limit, 1, 200, 100)],
    );
    res.json({ safe: { address: safe, nonce, threshold, owners }, proposals: rows });
  }));

  r.post('/proposals', requireRole('admin'), ah(async (req, res) => {
    const safe = await currentSafe();
    if (!safe) throw bad('The marketplace is not owned by a Safe, so there is nothing to propose.');
    const b = req.body || {};
    const to = lc(b.to);
    const data = lc(b.data || '0x');
    if (!ADDR.test(to)) throw bad('Invalid target address');
    if (!/^0x([0-9a-f]{2})*$/.test(data) || data.length > 20000) throw bad('Invalid call data');
    if (!/^\d{1,78}$/.test(String(b.value ?? '0'))) throw bad('Invalid value');
    const value = BigInt(String(b.value ?? '0'));
    const call = checkCall({ to, value, data }, await proposalTargets(safe));
    const kind = KIND[call.fn] || 'other';
    const label = cleanLabel(b.label) || `${call.role}.${call.fn}`;

    const onchain = Number(await safeContract(safe).nonce());
    await reconcile(safe, onchain);
    const row = await tx(async (h) => {
      await lockSafe(h, safe);
      let nonce;
      if (b.nonce !== undefined && b.nonce !== null) {
        // A replacement for a queued transaction ("reject": a no-op that uses up the same nonce).
        nonce = clampInt(b.nonce, 0, Number.MAX_SAFE_INTEGER, -1);
        if (call.fn !== 'cancel') throw bad('Only a cancel transaction can reuse a queued nonce');
        if (nonce < onchain) throw bad('That nonce was already used');
        const queued = await h.one(`select 1 from app.safe_proposals where chain_id = $1 and safe = $2 and status = 'pending' and nonce = $3`, [config.chainId, safe, nonce]);
        if (!queued) throw bad('Nothing is queued at that nonce');
      } else {
        const m = await h.one(`select max(nonce) as n from app.safe_proposals where chain_id = $1 and safe = $2 and status = 'pending' and nonce >= $3`, [config.chainId, safe, onchain]);
        nonce = m?.n === null || m?.n === undefined ? onchain : Math.max(onchain, Number(m.n) + 1);
      }
      const hash = await safeTxHash(safe, { to, value, data, nonce });
      const dup = await h.one(`select id from app.safe_proposals where chain_id = $1 and safe_tx_hash = $2 and status <> 'discarded'`, [config.chainId, hash]);
      if (dup) throw bad('The same transaction is already in the queue');
      return h.one(
        `insert into app.safe_proposals (chain_id, safe, to_address, value_wei, data, nonce, safe_tx_hash, kind, label, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, nonce`,
        [config.chainId, safe, to, value.toString(), data, nonce, hash, kind, label, req.user],
      );
    });
    await audit(req, 'safe.propose', safe, { id: row.id, nonce: Number(row.nonce), kind, to, fn: call.fn, args: call.args, label });
    res.json({ proposal: await one(`select ${PROPOSAL_COLS} from app.safe_proposals p where p.id = $1`, [row.id]) });
  }));

  async function loadPending(id) {
    const p = await one(`select * from app.safe_proposals where id = $1 and chain_id = $2`, [clampInt(id, 1, Number.MAX_SAFE_INTEGER, 0), config.chainId]);
    if (!p) throw notFound('Proposal not found');
    return p;
  }

  r.post('/proposals/:id/sign', requireRole('admin'), ah(async (req, res) => {
    const p = await loadPending(req.params.id);
    if (p.status !== 'pending') throw bad(`This proposal is ${p.status}`);
    const safe = await currentSafe();
    if (p.safe !== safe) throw bad('This proposal belongs to a different Safe');
    const s = safeContract(safe);
    if (p.nonce < Number(await s.nonce())) throw bad('The Safe already used this nonce. Refresh the queue.');
    const hash = await safeTxHash(safe, { to: p.to_address, value: p.value_wei, data: p.data, nonce: p.nonce });
    if (hash !== p.safe_tx_hash) throw bad('The stored transaction does not match the Safe. Nothing was saved.');
    const { signature, signer } = recoverSigner(hash, req.body?.signature);
    if (signer !== req.user) throw bad('The signature is from a different wallet than the one signed in to the panel');
    if (!(await s.isOwner(signer))) throw bad('This wallet is not an owner of the Safe');
    const saved = await tx(async (h) => {
      await lockSafe(h, safe);
      // Only if the proposal still has exactly this hash (it may have been moved or removed meanwhile).
      const r2 = await h.q(
        `insert into app.safe_signatures (proposal_id, signer, signature)
         select $1, $2, $3 where exists (select 1 from app.safe_proposals where id = $1 and status = 'pending' and safe_tx_hash = $4)
         on conflict (proposal_id, signer) do update set signature = excluded.signature, created_at = now()`,
        [p.id, signer, signature, hash],
      );
      if (r2.rowCount) await h.q(`update app.safe_proposals set updated_at = now() where id = $1`, [p.id]);
      return r2.rowCount;
    });
    if (!saved) throw bad('The proposal changed while you were signing. Refresh the queue and sign again.');
    await audit(req, 'safe.sign', safe, { id: p.id, nonce: Number(p.nonce), label: p.label });
    res.json({ proposal: await one(`select ${PROPOSAL_COLS} from app.safe_proposals p where p.id = $1`, [p.id]) });
  }));

  r.post('/proposals/:id/executed', requireRole('admin'), ah(async (req, res) => {
    const p = await loadPending(req.params.id);
    const txHash = lc(req.body?.txHash);
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw bad('Invalid transaction hash');
    if (p.status !== 'pending' && p.status !== 'replaced') return res.json({ ok: true, status: p.status });
    let rc = null;
    for (let i = 0; i < 6 && !rc; i++) {
      rc = await getProvider().getTransactionReceipt(txHash).catch(() => null);
      if (!rc) await new Promise((r2) => setTimeout(r2, 1500));
    }
    if (!rc) throw bad('Transaction not found yet. It will show as executed once the history catches up.');
    if (lc(rc.to) !== p.safe) throw bad('That transaction was not sent to the Safe');
    let result = null;
    for (const log of rc.logs) {
      if (lc(log.address) !== p.safe) continue;
      const ev = (() => { try { return safeIface.parseLog(log); } catch { return null; } })();
      if (ev && (ev.name === 'ExecutionSuccess' || ev.name === 'ExecutionFailure') && lc(ev.args.txHash) === p.safe_tx_hash) result = ev.name;
    }
    if (!result) throw bad('That transaction did not execute this proposal');
    const blk = await getProvider().getBlock(rc.blockNumber).catch(() => null);
    await q(
      `update app.safe_proposals set status = $2, executed_tx = $3, executed_by = $4, executed_at = $5, updated_at = now() where id = $1`,
      [p.id, result === 'ExecutionSuccess' ? 'executed' : 'failed', txHash, lc(rc.from), blk ? new Date(blk.timestamp * 1000) : new Date()],
    );
    await audit(req, 'safe.execute', p.safe, { id: p.id, nonce: Number(p.nonce), tx: txHash, ok: result === 'ExecutionSuccess', label: p.label });
    refreshTreasury(0).catch(() => undefined);
    res.json({ ok: true, status: result === 'ExecutionSuccess' ? 'executed' : 'failed' });
  }));

  /**
   * Removes a proposal from the queue. Only UNSIGNED proposals can be removed or moved: a signature stays valid
   * on-chain for its nonce, so renumbering signed proposals would let old signatures run them again. For a signed
   * proposal, use "Reject on-chain" (a no-op at the same nonce) instead.
   */
  r.post('/proposals/:id/discard', requireRole('admin'), ah(async (req, res) => {
    const p0 = await loadPending(req.params.id);
    if (p0.status !== 'pending') throw bad(`This proposal is ${p0.status}`);
    const safe = p0.safe;
    const onchain = Number(await safeContract(safe).nonce());
    await reconcile(safe, onchain);
    const result = await tx(async (h) => {
      await lockSafe(h, safe);
      const p = await h.one(`select id, nonce, status, label from app.safe_proposals where id = $1`, [p0.id]);
      if (!p || p.status !== 'pending') throw bad('This proposal is no longer pending. Refresh the queue.');
      const nonce = Number(p.nonce);
      if (nonce < onchain) {
        // Its nonce is used up, so its signatures can never run: just clear it.
        await h.q(`update app.safe_proposals set status = 'discarded', updated_at = now() where id = $1`, [p.id]);
        return { moved: [] };
      }
      const own = await h.one(`select count(*)::int as n from app.safe_signatures where proposal_id = $1`, [p.id]);
      if (own.n) throw bad('This proposal already has signatures, which stay valid on-chain. Use "Reject on-chain" to cancel it for good.');
      const sameNonce = await h.one(`select count(*)::int as n from app.safe_proposals where chain_id = $1 and safe = $2 and status = 'pending' and nonce = $3 and id <> $4`,
        [config.chainId, safe, nonce, p.id]);
      const later = sameNonce.n ? [] : await h.many(
        `select p.id, p.to_address, p.value_wei::text as value_wei, p.data, p.nonce,
           (select count(*)::int from app.safe_signatures s where s.proposal_id = p.id) as sigs
         from app.safe_proposals p where p.chain_id = $1 and p.safe = $2 and p.status = 'pending' and p.nonce > $3 order by p.nonce, p.id`,
        [config.chainId, safe, nonce],
      );
      if (later.some((l) => l.sigs > 0)) {
        throw bad('Later proposals already have signatures, so they cannot move up. Use "Reject on-chain" to fill this nonce instead.');
      }
      const moved = [];
      for (const l of later) moved.push({ id: l.id, nonce: Number(l.nonce) - 1, hash: await safeTxHash(safe, { to: l.to_address, value: l.value_wei, data: l.data, nonce: Number(l.nonce) - 1 }) });
      await h.q(`update app.safe_proposals set status = 'discarded', updated_at = now() where id = $1`, [p.id]);
      for (const m of moved) await h.q(`update app.safe_proposals set nonce = $2, safe_tx_hash = $3, updated_at = now() where id = $1`, [m.id, m.nonce, m.hash]);
      return { moved };
    });
    await audit(req, 'safe.discard', safe, { id: p0.id, nonce: Number(p0.nonce), label: p0.label, moved: result.moved.map((m) => m.id) });
    res.json({ ok: true, moved: result.moved.length });
  }));
}
