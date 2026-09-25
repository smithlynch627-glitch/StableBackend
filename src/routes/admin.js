// Admin panel API. Every route: signed-in wallet + role looked up fresh + audit log for changes.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { JsonRpcProvider, Contract } from 'ethers';
import { config } from '../config.js';
import { many, one, q, tx } from '../db.js';
import { HttpError, ah, addrParam, bad, clampInt, notFound } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { audit, requireRole } from '../lib/admin.js';
import { decrypt } from '../lib/crypto.js';
import { COLLECTION_COLS } from '../lib/queries.js';
import { discover, importCollection } from '../lib/explorer.js';
import { SETTING_KEYS, getSettings, setSettings } from '../lib/settings.js';
import { loadNetwork, listNetworks } from '../lib/network.js';
import { chainFees, collectionContract, factory as factoryContract, getProvider, market as marketContract } from '../lib/chain.js';
import { applyCollectionFlags, queueMetadata, syncCollectionFromChain } from '../indexer/core.js';

const r = Router();
// Defense in depth: the admin API only answers the separate admin site, never the public marketplace origin.
r.use((req, _res, next) => {
  const origin = req.headers.origin;
  if (!origin || !config.adminOrigins.includes(origin)) return next(new HttpError(403, 'Admin API is only available from the admin site', 'admin_origin'));
  next();
});
r.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
r.use(requireAuth);

const ADDR = /^0x[0-9a-f]{40}$/;
const optAddr = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  const a = String(v).trim().toLowerCase();
  if (!ADDR.test(a)) throw bad(`Invalid ${name}`);
  return a;
};
const url = (v, name, required = false) => {
  if (!v) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const s = String(v).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > 300) throw bad(`Invalid ${name}`);
  return s;
};

// ── Session / overview ─────────────────────────────────────────────────────────
r.get('/me', requireRole('support'), ah(async (req, res) => res.json({ address: req.user, role: req.role })));

r.get('/overview', requireRole('support'), ah(async (_req, res) => {
  const [stats, tickets] = await Promise.all([
    one(`select
       (select count(*) from collections)::int as collections,
       (select count(*) from collections where hidden)::int as hidden_collections,
       (select count(*) from tokens)::int as tokens,
       (select count(*) from orders where status = 'active')::int as active_orders,
       (select count(*) from activity where type = 'sale')::int as sales,
       (select coalesce(sum(price_wei),0) from activity where type = 'sale') as volume_wei,
       (select coalesce(sum(price_wei),0) from activity where type = 'sale' and created_at > now() - interval '24 hours') as volume_24h_wei,
       (select coalesce(sum(amount_wei),0) from fee_ledger where source = 'mint') as mint_fees_wei,
       (select coalesce(sum(amount_wei),0) from fee_ledger where source = 'trade') as trade_fees_wei,
       (select count(*) from app.users)::int as users`),
    one(`select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'waiting')::int as waiting from app.support_tickets`),
  ]);
  res.json({ stats, tickets, network: { key: config.networkKey, name: config.networkName, chainId: config.chainId, isTestnet: config.isTestnet } });
}));

// ── Collections ───────────────────────────────────────────────────────────────
r.get('/collections', requireRole('admin'), ah(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const rows = await many(
    `select ${COLLECTION_COLS} from collections c
     where ($1 = '' or c.name ilike '%' || $1 || '%' or c.address = lower($1))
     order by c.is_official desc, c.featured desc, c.created_at desc limit 300`,
    [term.replace(/[%_]/g, '')],
  );
  res.json({ collections: rows });
}));

r.get('/collections/:address', requireRole('admin'), ah(async (req, res) => {
  const row = await one(`select ${COLLECTION_COLS}, c.about, c.about_image_url, c.about_items from collections c where c.address = $1`, [addrParam(req.params.address)]);
  if (!row) throw notFound('Collection not found');
  res.json({ collection: row });
}));

r.patch('/collections/:address', requireRole('admin'), ah(async (req, res) => {
  const address = addrParam(req.params.address);
  const b = req.body || {};
  const sets = [];
  const params = [address];
  const set = (col, val) => (params.push(val), sets.push(`${col} = $${params.length}`));
  for (const f of ['verified', 'featured', 'hidden', 'drop_hidden']) if (typeof b[f] === 'boolean') set(f, b[f]);
  if (typeof b.name === 'string' && b.name.trim()) set('name', b.name.trim().slice(0, 80));
  if (typeof b.description === 'string') set('description', b.description.slice(0, 2000));
  if ('image_url' in b) set('image_url', b.image_url ? String(b.image_url).slice(0, 500) : null);
  if ('banner_url' in b) set('banner_url', b.banner_url ? String(b.banner_url).slice(0, 500) : null);
  if ('twitter' in b) set('twitter', url(b.twitter, 'X link'));
  if ('website' in b) set('website', url(b.website, 'website'));
  if ('discord' in b) set('discord', url(b.discord, 'Discord link'));
  if ('about' in b) set('about', b.about ? String(b.about).slice(0, 8000) : null);
  if ('about_image_url' in b) {
    const v = String(b.about_image_url || '').trim();
    set('about_image_url', /^ipfs:\/\/[^\s]{10,290}$/i.test(v) ? v : url(v, 'About image'));
  }
  if ('about_items' in b) {
    if (!Array.isArray(b.about_items) || b.about_items.length > 12) throw bad('About details: up to 12 rows');
    const items = b.about_items
      .map((x) => ({ label: String(x?.label || '').trim().slice(0, 40), value: String(x?.value || '').trim().slice(0, 300) }))
      .filter((x) => x.label && x.value);
    set('about_items', JSON.stringify(items));
  }
  if ('telegram' in b) set('telegram', url(b.telegram, 'Telegram link'));
  if (typeof b.slug === 'string') {
    if (!/^[a-z0-9-]{3,60}$/.test(b.slug)) throw bad('Slug must be 3-60 lowercase letters, numbers or dashes');
    set('slug', b.slug);
  }
  if (!sets.length) throw bad('Nothing to update');
  const row = await one(`update collections set ${sets.join(', ')} where address = $1 returning address`, params).catch((e) => {
    if (e.code === '23505') throw bad('That slug is already used');
    throw e;
  });
  if (!row) throw notFound('Collection not found');
  if (typeof b.featured === 'boolean') await q(`update drops set featured = $2 where collection = $1`, [address, b.featured]);
  await audit(req, 'collection.update', address, b);
  res.json({ collection: await one(`select ${COLLECTION_COLS}, c.about, c.about_image_url, c.about_items from collections c where c.address = $1`, [address]) });
}));

/** Removes a collection (and its items, orders and activity) from the marketplace database. On-chain nothing changes. */
r.delete('/collections/:address', requireRole('admin'), ah(async (req, res) => {
  const address = addrParam(req.params.address);
  if (String(req.body?.confirm || '').toLowerCase() !== address) throw bad('Type the collection address to confirm');
  if (address === config.officialCollection) throw bad('GIWA COWS is the official collection. Change it in Network settings first.');
  const col = await one(`delete from collections where address = $1 returning name`, [address]);
  if (!col) throw notFound('Collection not found');
  await audit(req, 'collection.remove', address, { name: col.name });
  res.json({ ok: true });
}));

r.post('/collections/:address/refresh', requireRole('admin'), ah(async (req, res) => {
  const address = addrParam(req.params.address);
  const col = await one(`select is_external from collections where address = $1`, [address]);
  if (!col) throw notFound('Collection not found');
  if (col.is_external) await importCollection(address);
  else await syncCollectionFromChain(address);
  const ids = await many(`select token_id::text as id from tokens where collection = $1 limit 20000`, [address]);
  ids.forEach((t) => queueMetadata(address, t.id));
  await audit(req, 'collection.refresh', address);
  res.json({ ok: true, tokens: ids.length });
}));

// ── Site settings (footer community links) ──────────────────────────────────
r.get('/settings', requireRole('admin'), ah(async (_req, res) => res.json({ settings: await getSettings() })));
r.put('/settings', requireRole('admin'), ah(async (req, res) => {
  const b = req.body || {};
  const out = {};
  for (const k of SETTING_KEYS) if (k in b) out[k] = b[k] ? url(b[k], k.replace('social.', '') + ' link') : null;
  if (!Object.keys(out).length) throw bad('Nothing to update');
  await setSettings(out, req.user);
  await audit(req, 'settings.update', null, out);
  res.json({ settings: await getSettings() });
}));

// ── Discover existing collections on the network (Blockscout) ──────────────────
r.get('/discover', requireRole('admin'), ah(async (req, res) => {
  let page = null;
  if (req.query.page) {
    try { page = JSON.parse(String(req.query.page)); } catch { throw bad('Invalid page'); }
  }
  res.json(await discover(page));
}));

r.post('/import', requireRole('admin'), ah(async (req, res) => {
  const address = addrParam(req.body?.address);
  const out = await importCollection(address, clampInt(req.body?.maxTokens, 1, 20000, 5000));
  await audit(req, 'collection.import', address, out);
  res.json(out);
}));

// ── On-chain status for the Contracts tab (transactions are sent from the admin's wallet) ──
r.get('/chain', requireRole('admin'), ah(async (_req, res) => {
  if (!config.market) return res.json({ ready: false });
  const erc20 = new Contract(config.weth, ['function balanceOf(address) view returns (uint256)'], getProvider());
  const [mOwner, mPaused, fRecipient, fOwner, fPaused, mFee, fFee, vaultEth, vaultWeth, block] = await Promise.all([
    marketContract().owner(), marketContract().paused(), marketContract().feeRecipient(),
    factoryContract().owner(), factoryContract().paused(), marketContract().marketFeeBps(), factoryContract().platformFeeBps(),
    getProvider().getBalance(config.feeVault), erc20.balanceOf(config.feeVault), getProvider().getBlockNumber(),
  ]);
  const vaultOwner = await new Contract(config.feeVault, ['function owner() view returns (address)'], getProvider()).owner();
  res.json({
    ready: true, block, market: { address: config.market, owner: mOwner, paused: mPaused, feeBps: Number(mFee), feeRecipient: fRecipient },
    factory: { address: config.factory, owner: fOwner, paused: fPaused, feeBps: Number(fFee) },
    vault: { address: config.feeVault, owner: vaultOwner, eth: vaultEth.toString(), weth: vaultWeth.toString() }, weth: config.weth,
  });
}));

// ── Networks (owner only): switch testnet → mainnet here ───────────────────────
const NETWORK_FIELDS = ['name', 'rpc_url', 'public_rpc_url', 'explorer_url', 'explorer_api_url', 'is_testnet', 'market_address',
  'factory_address', 'fee_vault_address', 'weth_address', 'official_collection', 'start_block'];

function cleanNetwork(b, partial = false) {
  const n = {};
  if (!partial || 'name' in b) { if (!b.name?.trim()) throw bad('Name is required'); n.name = String(b.name).trim().slice(0, 60); }
  if (!partial || 'rpc_url' in b) n.rpc_url = url(b.rpc_url, 'RPC URL', true);
  if ('public_rpc_url' in b) {
    n.public_rpc_url = url(b.public_rpc_url, 'public RPC URL');
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${n.public_rpc_url}/`);
    if (n.public_rpc_url && !n.public_rpc_url.startsWith('https://') && !local) throw bad('Public RPC must use https');
  }
  if (!partial || 'explorer_url' in b) n.explorer_url = url(b.explorer_url, 'explorer URL', true);
  if ('explorer_api_url' in b) n.explorer_api_url = url(b.explorer_api_url, 'explorer API URL');
  if ('is_testnet' in b) n.is_testnet = Boolean(b.is_testnet);
  for (const f of ['market_address', 'factory_address', 'fee_vault_address', 'official_collection']) if (f in b) n[f] = optAddr(b[f], f.replace('_', ' '));
  if ('weth_address' in b) n.weth_address = optAddr(b.weth_address, 'WETH address') || '0x4200000000000000000000000000000000000006';
  if ('start_block' in b) n.start_block = clampInt(b.start_block, 0, Number.MAX_SAFE_INTEGER, 0);
  return n;
}

/** Proves an RPC really serves the expected chain and that the contracts exist there. */
async function checkNetwork(n, chainId) {
  const p = new JsonRpcProvider(n.rpc_url, undefined, { staticNetwork: false });
  const checks = [];
  try {
    const net = await Promise.race([p.getNetwork(), new Promise((_, rej) => setTimeout(() => rej(new Error('RPC timeout')), 8000))]);
    const ok = Number(net.chainId) === Number(chainId);
    checks.push({ check: 'rpc', ok, detail: ok ? `chain ${net.chainId}` : `RPC is chain ${net.chainId}, expected ${chainId}` });
    for (const f of ['market_address', 'factory_address', 'fee_vault_address', 'weth_address', 'official_collection']) {
      if (!n[f]) continue;
      const code = await p.getCode(n[f]);
      checks.push({ check: f, ok: code !== '0x', detail: code !== '0x' ? 'contract found' : 'no contract at this address' });
    }
  } catch (e) {
    checks.push({ check: 'rpc', ok: false, detail: e.shortMessage || e.message });
  } finally {
    p.destroy();
  }
  return checks;
}

r.get('/networks', requireRole('owner'), ah(async (_req, res) => res.json({ networks: await listNetworks() })));

r.post('/networks', requireRole('owner'), ah(async (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim();
  if (!/^[a-z0-9-]{3,40}$/.test(key)) throw bad('Key must be 3-40 lowercase letters, numbers or dashes');
  const chainId = clampInt(b.chain_id, 1, 2 ** 31 - 1, 0);
  if (!chainId) throw bad('Chain ID is required');
  const n = cleanNetwork(b);
  const checks = await checkNetwork(n, chainId);
  if (!checks.find((c) => c.check === 'rpc')?.ok) throw bad(checks[0].detail);
  const cols = ['key', 'chain_id', ...Object.keys(n), 'updated_by'];
  const vals = [key, chainId, ...Object.values(n), req.user];
  await q(`insert into app.networks (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals).catch((e) => {
    if (e.code === '23505') throw bad('A network with this key or chain ID already exists');
    throw e;
  });
  await audit(req, 'network.create', key, { ...n, chain_id: chainId });
  res.json({ network: await one(`select * from app.networks where key = $1`, [key]), checks });
}));

r.put('/networks/:key', requireRole('owner'), ah(async (req, res) => {
  const cur = await one(`select * from app.networks where key = $1`, [req.params.key]);
  if (!cur) throw notFound('Network not found');
  const n = cleanNetwork(req.body || {}, true);
  const merged = { ...cur, ...n };
  const checks = await checkNetwork(merged, cur.chain_id);
  if (!checks.find((c) => c.check === 'rpc')?.ok) throw bad(checks[0].detail);
  const bad_ = checks.filter((c) => !c.ok);
  if (bad_.length) throw bad(`Check failed: ${bad_.map((c) => `${c.check} (${c.detail})`).join(', ')}`);
  const keys = Object.keys(n).filter((k) => NETWORK_FIELDS.includes(k));
  if (keys.length) {
    await q(
      `update app.networks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() where key = $1`,
      [cur.key, ...keys.map((k) => n[k]), req.user],
    );
  }
  await audit(req, 'network.update', cur.key, n);
  if (cur.is_active) { await loadNetwork(); await applyCollectionFlags().catch(() => {}); }
  res.json({ network: await one(`select * from app.networks where key = $1`, [cur.key]), checks });
}));

r.post('/networks/:key/test', requireRole('owner'), ah(async (req, res) => {
  const cur = await one(`select * from app.networks where key = $1`, [req.params.key]);
  if (!cur) throw notFound('Network not found');
  res.json({ checks: await checkNetwork(cur, cur.chain_id) });
}));

r.post('/networks/:key/activate', requireRole('owner'), ah(async (req, res) => {
  const target = await one(`select * from app.networks where key = $1`, [req.params.key]);
  if (!target) throw notFound('Network not found');
  if (req.body?.confirm !== target.key) throw bad(`Type the network key "${target.key}" to confirm`);
  const checks = await checkNetwork(target, target.chain_id);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) throw bad(`Cannot switch: ${failed.map((c) => `${c.check} (${c.detail})`).join(', ')}`);
  if (!target.market_address || !target.factory_address || !target.fee_vault_address) throw bad('Set the marketplace, factory and vault addresses first');
  const previous = config.networkKey;
  await tx(async (db) => {
    await db.q(`update app.networks set is_active = false where is_active`);
    await db.q(`update app.networks set is_active = true, updated_by = $2, updated_at = now() where key = $1`, [target.key, req.user]);
  });
  await loadNetwork();
  await applyCollectionFlags().catch(() => {});
  await audit(req, 'network.activate', target.key, { from: previous, chain_id: target.chain_id });
  res.json({ active: target.key, checks });
}));

// ── Team (owner) ──────────────────────────────────────────────────────────────
r.get('/admins', requireRole('owner'), ah(async (_req, res) => {
  const rows = await many(`select address, role, added_by, created_at from app.admins order by created_at`);
  res.json({ admins: [...config.rootAdmins.map((a) => ({ address: a, role: 'owner', added_by: 'env', root: true })), ...rows.filter((r2) => !config.rootAdmins.includes(r2.address))] });
}));
r.post('/admins', requireRole('owner'), ah(async (req, res) => {
  const address = addrParam(req.body?.address);
  const role = String(req.body?.role || '');
  if (!['owner', 'admin', 'support'].includes(role)) throw bad('Role must be owner, admin or support');
  await q(`insert into app.admins (address, role, added_by) values ($1,$2,$3) on conflict (address) do update set role = excluded.role`, [address, role, req.user]);
  await audit(req, 'admin.set', address, { role });
  res.json({ ok: true });
}));
r.delete('/admins/:address', requireRole('owner'), ah(async (req, res) => {
  const address = addrParam(req.params.address);
  if (config.rootAdmins.includes(address)) throw bad('Root owners are set in the server env and cannot be removed here');
  if (address === req.user) throw bad('You cannot remove yourself');
  await q(`delete from app.admins where address = $1`, [address]);
  await audit(req, 'admin.remove', address);
  res.json({ ok: true });
}));

// ── Users ─────────────────────────────────────────────────────────────────────
r.post('/users/:address/ban', requireRole('admin'), ah(async (req, res) => {
  const address = addrParam(req.params.address);
  const banned = Boolean(req.body?.banned);
  await q(`insert into app.users (address, is_banned) values ($1,$2) on conflict (address) do update set is_banned = excluded.is_banned`, [address, banned]);
  if (banned) await q(`update orders set status = 'inactive', updated_at = now() where maker = $1 and status = 'active'`, [address]);
  await audit(req, banned ? 'user.ban' : 'user.unban', address);
  res.json({ ok: true });
}));

// ── Support tickets ──────────────────────────────────────────────────────────
r.get('/tickets', requireRole('support'), ah(async (req, res) => {
  const status = String(req.query.status || '');
  const rows = await many(
    `select id, ref, address, category, subject, status, priority, assigned_to, created_at, last_message_at,
       (select count(*) from app.ticket_messages m where m.ticket_id = t.id)::int as messages
     from app.support_tickets t where ($1 = '' or status = $1) order by
       case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, last_message_at desc limit 200`,
    [['open', 'waiting', 'resolved', 'closed'].includes(status) ? status : ''],
  );
  res.json({ tickets: rows });
}));

r.get('/tickets/:id', requireRole('support'), ah(async (req, res) => {
  const t = await one(`select * from app.support_tickets where id = $1`, [String(req.params.id)]).catch(() => null);
  if (!t) throw notFound('Ticket not found');
  const messages = await many(`select id, author, is_staff, body, created_at from app.ticket_messages where ticket_id = $1 order by id`, [t.id]);
  const { contact_enc, ...rest } = t;
  await audit(req, 'ticket.view', t.ref);
  res.json({ ticket: { ...rest, contact: decrypt(contact_enc) }, messages });
}));

r.post('/tickets/:id/reply', requireRole('support'), ah(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > 4000) throw bad('Write a reply (max 4000 characters)');
  const status = ['open', 'waiting', 'resolved', 'closed'].includes(req.body?.status) ? req.body.status : 'waiting';
  const t = await one(`update app.support_tickets set status = $2, updated_at = now(), last_message_at = now(), assigned_to = coalesce(assigned_to, $3)
                       where id = $1 returning id, ref`, [String(req.params.id), status, req.user]).catch(() => null);
  if (!t) throw notFound('Ticket not found');
  await q(`insert into app.ticket_messages (ticket_id, author, is_staff, body) values ($1,$2,true,$3)`, [t.id, req.user, body]);
  await audit(req, 'ticket.reply', t.ref, { status });
  res.json({ ok: true });
}));

r.patch('/tickets/:id', requireRole('support'), ah(async (req, res) => {
  const b = req.body || {};
  const t = await one(
    `update app.support_tickets set status = coalesce($2, status), priority = coalesce($3, priority), assigned_to = coalesce($4, assigned_to), updated_at = now()
     where id = $1 returning ref`,
    [String(req.params.id), ['open', 'waiting', 'resolved', 'closed'].includes(b.status) ? b.status : null,
      ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : null, b.assigned_to ? optAddr(b.assigned_to, 'assignee') : null],
  ).catch(() => null);
  if (!t) throw notFound('Ticket not found');
  await audit(req, 'ticket.update', t.ref, b);
  res.json({ ok: true });
}));

// ── Audit log ────────────────────────────────────────────────────────────────
r.get('/audit', requireRole('admin'), ah(async (req, res) => {
  const before = clampInt(req.query.before, 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = await many(
    `select id, actor, action, target, details, created_at from app.audit_log where ($1 = 0 or id < $1) order by id desc limit 100`,
    [before],
  );
  res.json({ entries: rows });
}));

export default r;
