import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';

const addr = (v) => (v ? String(v).trim().toLowerCase() : '');
const list = (v) => String(v || '').split(',').map(addr).filter(Boolean);

function readCa(v) {
  if (!v) return null;
  if (v.includes('BEGIN CERTIFICATE')) return v.replace(/\\n/g, '\n');
  return existsSync(v) ? readFileSync(v, 'utf8') : null;
}

/**
 * Server settings come from env. Network settings (chain, RPC, contracts) are loaded from
 * app.networks at startup and whenever an admin switches network; env values only seed the first network.
 */
export const config = {
  port: Number(process.env.PORT || 8080),
  env: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/giwa_market',
  databaseCa: readCa(process.env.DATABASE_CA_CERT),
  jwtSecret: process.env.JWT_SECRET || '',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  // The separate admin site(s). /api/admin only answers requests coming from these origins.
  adminOrigins: (process.env.ADMIN_ORIGINS || 'http://localhost:5174').split(',').map((s) => s.trim()).filter(Boolean),
  apiPublicUrl: (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, ''),
  rootAdmins: list(process.env.ADMIN_ADDRESSES).filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
  encryptionKey: process.env.DATA_ENCRYPTION_KEY || '',
  pinataJwt: process.env.PINATA_JWT || '',
  verifiedCollections: list(process.env.VERIFIED_COLLECTIONS),
  officialSlug: 'giwa-cows',
  indexerPollMs: Number(process.env.INDEXER_POLL_MS || 3000),

  // ── active network (mutated by lib/network.js) ──
  networkKey: 'giwa-sepolia',
  networkName: 'GIWA Sepolia',
  isTestnet: true,
  chainId: Number(process.env.CHAIN_ID || 91342),
  rpcUrl: process.env.RPC_URL || 'https://sepolia-rpc.giwa.io',
  publicRpcUrl: process.env.PUBLIC_RPC_URL || process.env.RPC_URL || 'https://sepolia-rpc.giwa.io',
  explorerUrl: process.env.EXPLORER_URL || 'https://sepolia-explorer.giwa.io',
  explorerApiUrl: process.env.EXPLORER_API_URL || 'https://sepolia-explorer.giwa.io/api/v2',
  market: addr(process.env.MARKET_ADDRESS),
  factory: addr(process.env.LAUNCHPAD_FACTORY_ADDRESS),
  feeVault: addr(process.env.FEE_VAULT_ADDRESS),
  weth: addr(process.env.WETH_ADDRESS || '0x4200000000000000000000000000000000000006'),
  officialCollection: addr(process.env.OFFICIAL_COLLECTION_ADDRESS),
  indexerStartBlock: Number(process.env.INDEXER_START_BLOCK || 0),
};

export const contractsReady = () => Boolean(config.market && config.factory && config.feeVault);

if (!config.jwtSecret || config.jwtSecret.length < 32) {
  if (config.env === 'production') throw new Error('JWT_SECRET must be at least 32 characters');
  console.warn('[config] JWT_SECRET is missing or short. Using an insecure development secret.');
  config.jwtSecret = config.jwtSecret || 'dev-only-secret-dev-only-secret-000';
}
{
  const raw = list(process.env.ADMIN_ADDRESSES);
  const invalid = raw.filter((a) => !/^0x[0-9a-f]{40}$/.test(a));
  if (invalid.length) console.warn(`[config] ADMIN_ADDRESSES has invalid entries (ignored): ${invalid.join(', ')}`);
  const shown = config.rootAdmins.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(', ');
  console.log(`[config] root admin wallets from ADMIN_ADDRESSES: ${shown || 'none set'}`);
}
if (!config.encryptionKey) console.warn('[config] DATA_ENCRYPTION_KEY is not set. Support contact details will not be stored.');

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
