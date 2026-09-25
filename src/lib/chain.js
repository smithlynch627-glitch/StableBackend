import { Contract, JsonRpcProvider } from 'ethers';
import { config } from '../config.js';

let provider;
export function getProvider() {
  if (!provider) provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true, batchMaxCount: 20 });
  return provider;
}

/** Called when the admin switches network: new RPC, fresh caches. */
export function resetChainClients() {
  provider?.destroy?.();
  provider = null;
  feeCache.at = 0;
  feeCache.marketFeeBps = null;
  feeCache.mintFeeBps = null;
}

const ORDER_TUPLE =
  'tuple(address maker, uint8 side, address collection, uint256 tokenId, bool anyToken, uint256 price, uint16 maxFeeBps, uint16 maxRoyaltyBps, uint64 expiry, uint256 salt, uint256 counter)';

export const MARKET_ABI = [
  'function marketFeeBps() view returns (uint16)',
  'function counters(address) view returns (uint256)',
  `function hashOrder(${ORDER_TUPLE} o) view returns (bytes32)`,
  `function checkOrder(${ORDER_TUPLE} o, bytes signature, uint256 tokenId, address taker) view returns (uint8)`,
  'function isTradable(address) view returns (bool)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function feeRecipient() view returns (address)',
  'function approvedCollections(address) view returns (bool)',
  'function blockedCollections(address) view returns (bool)',
  'event CollectionApprovalSet(address indexed collection, bool approved)',
  'event CollectionBlockedSet(address indexed collection, bool blocked)',
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, address collection, uint256 tokenId, uint256 price, uint256 fee, uint256 royalty)',
  'event OrderCancelled(bytes32 indexed orderHash, address indexed maker)',
  'event CounterIncremented(address indexed maker, uint256 newCounter)',
];

export const FACTORY_ABI = [
  'function platformFeeBps() view returns (uint16)',
  'function isCollection(address) view returns (bool)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'event CollectionCreated(address indexed collection, address indexed creator, uint256 platformFeeBps)',
];

export const COLLECTION_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function maxSupply() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function platformFeeBps() view returns (uint16)',
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function revealed() view returns (bool)',
  'function metadataFrozen() view returns (bool)',
  'function mintPaused() view returns (bool)',
  'function contractURI() view returns (string)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function getPhases() view returns (tuple(uint64 startTime, uint64 endTime, uint256 price, uint32 maxPerWallet, bytes32 merkleRoot)[])',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  'event Minted(address indexed to, uint256 indexed phaseId, uint256 firstTokenId, uint256 quantity, uint256 paid, uint256 platformFee)',
  'event PhaseUpdated(uint256 indexed phaseId)',
  'event Revealed(string baseURI)',
  'event BaseURIUpdated(string baseURI)',
  'event UnrevealedURIUpdated(string uri)',
  'event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId)',
  'event MetadataFrozen()',
  'event MintPausedSet(bool paused)',
  'event ContractURIUpdated(string uri)',
  'event MaxSupplyReduced(uint256 maxSupply)',
];

export const ERC721_ABI_MIN = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function royaltyInfo(uint256, uint256) view returns (address, uint256)',
];

export const market = () => new Contract(config.market, MARKET_ABI, getProvider());
export const factory = () => new Contract(config.factory, FACTORY_ABI, getProvider());
export const collectionContract = (address) => new Contract(address, COLLECTION_ABI, getProvider());

/** Fees read from the contracts (cached for 15 s) so the API never disagrees with the chain. */
const feeCache = { at: 0, marketFeeBps: null, mintFeeBps: null };
export async function chainFees() {
  if (Date.now() - feeCache.at < 15_000 && feeCache.marketFeeBps !== null) return feeCache;
  try {
    const [m, f] = await Promise.all([market().marketFeeBps(), factory().platformFeeBps()]);
    Object.assign(feeCache, { at: Date.now(), marketFeeBps: Number(m), mintFeeBps: Number(f) });
  } catch (e) {
    console.warn('[chain] could not read fees:', e.shortMessage || e.message);
  }
  return feeCache;
}
