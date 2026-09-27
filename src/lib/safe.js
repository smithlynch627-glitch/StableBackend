// Safe (multisig) support for the admin panel. GIWA has no Safe web app, so owners propose, sign (EIP-712 SafeTx)
// and execute here. The API never holds keys: it only stores proposals and signatures and double-checks them
// against the chain. The Safe contract re-checks every signature when a transaction is executed.
import { AbiCoder, Contract, Interface, TypedDataEncoder, ZeroAddress, getAddress, recoverAddress } from 'ethers';
import { config } from '../config.js';
import { getProvider, market as marketContract } from './chain.js';
import { bad } from './http.js';

export const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function isOwner(address) view returns (bool)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 _threshold)',
  'event SafeMultiSigTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, bytes additionalInfo)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
  'event AddedOwner(address owner)',
  'event RemovedOwner(address owner)',
  'event ChangedThreshold(uint256 threshold)',
  'event EnabledModule(address module)',
  'event DisabledModule(address module)',
  'event ChangedGuard(address guard)',
  'event ChangedFallbackHandler(address handler)',
];
export const safeIface = new Interface(SAFE_ABI);

// Storage slots of Safe v1.3.0 (keccak256 of the names below).
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'; // guard_manager.guard.address
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'; // fallback_manager.handler.address
const SENTINEL = '0x0000000000000000000000000000000000000001';
/** The official Safe v1.3.0 contracts on GIWA (same address on every chain). */
export const OFFICIAL = {
  singletonL2: '0x3e5c63644e683549055b9be8653de26e0b4cd36e',
  fallbackHandler: '0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4',
};

const OWNABLE_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function paused() view returns (bool)',
  'function guardian() view returns (address)',
];

// ── What a proposal may do ─────────────────────────────────────────────────────────
// Only these functions, on these contracts, with value 0 and a plain CALL (never DELEGATECALL). Plain ETH
// transfers from the Safe (empty data) are allowed to any address. Everything else is refused before it is stored.
const CALLS = {
  market: ['setMarketFeeBps(uint16)', 'setFeeRecipient(address)', 'setCollectionApproval(address,bool)', 'setCollectionBlocked(address,bool)',
    'setFactory(address,bool)', 'pause()', 'unpause()', 'setGuardian(address)', 'acceptOwnership()'],
  factory: ['setPlatformFeeBps(uint16)', 'pause()', 'unpause()', 'acceptOwnership()'],
  vault: ['withdrawEth(address,uint256)', 'withdrawAllEth(address)', 'withdrawToken(address,address,uint256)', 'setFactory(address,bool)', 'acceptOwnership()'],
  weth: ['transfer(address,uint256)', 'withdraw(uint256)'],
  safe: ['addOwnerWithThreshold(address,uint256)', 'removeOwner(address,address,uint256)', 'swapOwner(address,address,address)', 'changeThreshold(uint256)'],
};
const IFACES = Object.fromEntries(Object.entries(CALLS).map(([k, sigs]) => [k, new Interface(sigs.map((s) => `function ${s}`))]));

const lc = (a) => String(a || '').toLowerCase();

/** Every factory the marketplace accepts (current + previous versions). */
export async function marketFactories() {
  const list = await marketContract().factories().catch(() => []);
  return [...new Set([config.factory, ...list.map(lc)].filter(Boolean))];
}

/** The contracts a Safe proposal may call, by role. */
export async function proposalTargets(safe) {
  const [factories, owners] = await Promise.all([marketFactories(), safeContract(safe).getOwners().then((o) => o.map(lc))]);
  return { market: lc(config.market), vault: lc(config.feeVault), weth: lc(config.weth), safe: lc(safe), factories, owners };
}

/**
 * Validates a proposed Safe call. Returns { role, fn, args } or throws a 400 with the reason.
 * `to`/`data` are lowercase hex, `value` a bigint.
 */
export function checkCall({ to, value, data }, t) {
  if (data === '0x') {
    if (to === t.safe && value === 0n) return { role: 'safe', fn: 'cancel', args: [] }; // a no-op that uses up a nonce
    if (value <= 0n) throw bad('An ETH transfer needs an amount');
    if (to === t.safe) throw bad('The Safe cannot send ETH to itself');
    if (to === ZeroAddress || to === SENTINEL) throw bad('That address would burn the ETH');
    if ([t.market, t.vault, t.weth, ...t.factories].includes(to)) throw bad('Plain ETH cannot be sent to the STABLE contracts');
    return { role: 'transfer', fn: 'transfer', args: [to, value.toString()] };
  }
  if (value !== 0n) throw bad('Contract calls from the panel never send ETH');
  const role = to === t.market ? 'market' : to === t.vault ? 'vault' : to === t.weth ? 'weth' : to === t.safe ? 'safe' : t.factories.includes(to) ? 'factory' : null;
  if (!role) throw bad('That contract is not one of the STABLE contracts the Safe manages');
  let parsed;
  try {
    parsed = IFACES[role].parseTransaction({ data });
  } catch {
    parsed = null;
  }
  if (!parsed) throw bad(`That function is not allowed on the ${role} from the admin panel`);
  // Re-encode and compare, so trailing bytes or odd encodings can't hide anything.
  if (lc(IFACES[role].encodeFunctionData(parsed.fragment, parsed.args)) !== data) throw bad('The call data is not in standard form');
  const args = parsed.args.map((a) => (typeof a === 'bigint' ? a.toString() : typeof a === 'string' ? lc(a) : a));
  if (parsed.name === 'withdrawToken' && args[0] !== t.weth) throw bad('Only WETH can be withdrawn from the FeeVault');
  for (const a of args) if (a === ZeroAddress && !['setGuardian'].includes(parsed.name)) throw bad('Zero address is not allowed here');
  if (role === 'safe') {
    // Owner changes: never below 2 signatures, never more signatures than owners, never the Safe or 0x1 as an owner.
    const n = t.owners.length;
    const th = (x) => Number(x);
    if (parsed.name === 'addOwnerWithThreshold' && (th(args[1]) < 2 || th(args[1]) > n + 1)) throw bad(`Threshold must be between 2 and ${n + 1}`);
    if (parsed.name === 'removeOwner' && (th(args[2]) < 2 || th(args[2]) > n - 1)) throw bad(n - 1 < 2 ? 'Add an owner before removing one (at least 2 must stay)' : `Threshold must be between 2 and ${n - 1}`);
    if (parsed.name === 'changeThreshold' && (th(args[0]) < 2 || th(args[0]) > n)) throw bad(`Threshold must be between 2 and ${n}`);
    const newOwner = parsed.name === 'addOwnerWithThreshold' ? args[0] : parsed.name === 'swapOwner' ? args[2] : null;
    if (newOwner && (newOwner === t.safe || newOwner === SENTINEL || t.owners.includes(newOwner))) throw bad('Invalid new owner');
  }
  return { role, fn: parsed.name, args };
}

// ── Safe reads ─────────────────────────────────────────────────────────────────
export const safeContract = (address) => new Contract(address, SAFE_ABI, getProvider());

let cache = { at: 0, market: '', value: null };
/** The Safe that owns the marketplace, or null when the owner is a normal wallet. Cached 20 s. */
export async function currentSafe() {
  if (!config.market) return null;
  if (Date.now() - cache.at < 20_000 && cache.market === config.market) return cache.value;
  const owner = lc(await marketContract().owner());
  let value = null;
  if ((await getProvider().getCode(owner)) !== '0x') {
    const threshold = await safeContract(owner).getThreshold().catch(() => null);
    if (threshold !== null) value = owner;
  }
  cache = { at: Date.now(), market: config.market, value, owner };
  return value;
}
export const marketOwner = () => cache.owner || null;

export async function safeState(safe) {
  const s = safeContract(safe);
  const p = getProvider();
  const [owners, threshold, nonce, version, modules, guardRaw, fallbackRaw] = await Promise.all([
    s.getOwners(), s.getThreshold(), s.nonce(), s.VERSION().catch(() => 'unknown'),
    s.getModulesPaginated(SENTINEL, 10).then((r) => r[0]).catch(() => null),
    p.getStorage(safe, GUARD_SLOT).catch(() => null), p.getStorage(safe, FALLBACK_SLOT).catch(() => null),
  ]);
  const slotAddr = (v) => (v ? lc(getAddress(`0x${v.slice(-40)}`)) : null);
  return {
    address: safe,
    owners: owners.map(lc),
    threshold: Number(threshold),
    nonce: Number(nonce),
    version,
    modules: modules ? modules.map(lc) : null,
    guard: slotAddr(guardRaw),
    fallbackHandler: slotAddr(fallbackRaw),
  };
}

/** Owner / pending owner / paused of every contract the Safe should control. */
export async function managedContracts(safe) {
  const factories = await marketFactories();
  const list = [
    { key: 'market', name: 'Marketplace', address: lc(config.market) },
    { key: 'vault', name: 'FeeVault', address: lc(config.feeVault) },
    ...factories.map((f, i) => ({ key: `factory-${f}`, name: factories.length > 1 ? `Launchpad factory ${i + 1}` : 'Launchpad factory', address: f })),
  ].filter((c) => c.address);
  return Promise.all(list.map(async (c) => {
    const k = new Contract(c.address, OWNABLE_ABI, getProvider());
    const [owner, pendingOwner, paused] = await Promise.all([
      k.owner().then(lc).catch(() => null), k.pendingOwner().then(lc).catch(() => null), k.paused().catch(() => null),
    ]);
    return { ...c, owner, pendingOwner: pendingOwner && pendingOwner !== ZeroAddress ? pendingOwner : null, paused, ownedBySafe: !!safe && owner === safe };
  }));
}

// ── Hashes and signatures ──────────────────────────────────────────────────────
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};
const txMessage = ({ to, value, data, nonce }) => ({
  to, value: BigInt(value), data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: BigInt(nonce),
});

/** SafeTx hash, computed locally AND read from the Safe itself; both must agree. */
export async function safeTxHash(safe, tx) {
  const local = lc(TypedDataEncoder.hash({ chainId: config.chainId, verifyingContract: safe }, SAFE_TX_TYPES, txMessage(tx)));
  const onchain = lc(await safeContract(safe).getTransactionHash(tx.to, BigInt(tx.value), tx.data, 0, 0, 0, 0, ZeroAddress, ZeroAddress, BigInt(tx.nonce)));
  if (local !== onchain) throw bad('The Safe returned a different transaction hash than expected. Nothing was saved.');
  return onchain;
}

/** Normalizes a 65-byte ECDSA signature (v = 27/28) and returns { signature, signer }. */
export function recoverSigner(hash, sig) {
  let s = lc(sig);
  if (!/^0x[0-9a-f]{130}$/.test(s)) throw bad('Invalid signature');
  let v = parseInt(s.slice(-2), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) throw bad('Only a normal wallet signature (EIP-712) can be used');
  s = s.slice(0, -2) + v.toString(16);
  let signer;
  try {
    signer = lc(recoverAddress(hash, s));
  } catch {
    throw bad('Invalid signature');
  }
  return { signature: s, signer };
}

/** Decodes SafeMultiSigTransaction.additionalInfo = abi.encode(nonce, sender, threshold). */
export function decodeAdditionalInfo(info) {
  try {
    const [nonce, sender, threshold] = AbiCoder.defaultAbiCoder().decode(['uint256', 'address', 'uint256'], info);
    return { nonce: Number(nonce), sender: lc(sender), threshold: Number(threshold) };
  } catch {
    return { nonce: null, sender: null, threshold: null };
  }
}

export async function guardianOf() {
  return new Contract(config.market, OWNABLE_ABI, getProvider()).guardian().then(lc).catch(() => null);
}
