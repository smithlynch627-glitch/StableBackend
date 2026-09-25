// Seaport 1.6 order validation. Orders are created in the browser with seaport-js,
// signed by the maker, and stored here until they are filled, cancelled or expire.
import { TypedDataEncoder, verifyTypedData } from 'ethers';
import { config, ZERO_ADDRESS } from '../config.js';
import { bad } from './http.js';
import { erc20, erc721, seaport } from './chain.js';

export const ItemType = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3, ERC721_WITH_CRITERIA: 4, ERC1155_WITH_CRITERIA: 5 };

export const SEAPORT_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
};

const domain = () => ({ name: 'Seaport', version: '1.6', chainId: config.chainId, verifyingContract: config.seaport });

function components(p) {
  const { totalOriginalConsiderationItems, ...rest } = p;
  return rest;
}

export const orderHash = (parameters) => TypedDataEncoder.hashStruct('OrderComponents', SEAPORT_TYPES, components(parameters));

const lc = (v) => String(v).toLowerCase();
const big = (v) => BigInt(v);

/**
 * Parse a signed Seaport order into a marketplace row and check every rule:
 * shape, signature, timing, marketplace fee, creator royalty and on-chain state.
 */
export async function validateOrder(order, collection) {
  if (!config.seaport) throw bad('Seaport address is not configured', 'no_seaport');
  const p = order?.parameters;
  if (!p || typeof order.signature !== 'string') throw bad('Malformed order');
  const maker = lc(p.offerer);
  if (lc(p.zone) !== ZERO_ADDRESS) throw bad('Zoned orders are not supported');
  if (big(p.conduitKey) !== 0n) throw bad('Orders must approve Seaport directly (no conduit)');

  // Signature
  let signer;
  try {
    signer = lc(verifyTypedData(domain(), SEAPORT_TYPES, components(p), order.signature));
  } catch {
    throw bad('Order signature is invalid', 'bad_signature');
  }
  if (signer !== maker) throw bad('Order was not signed by the maker', 'bad_signature');

  // Timing
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (big(p.endTime) <= now) throw bad('Order is already expired');
  if (big(p.startTime) > now + 120n) throw bad('Order start time is in the future');

  // Counter
  const counter = await seaport().getCounter(maker);
  if (big(p.counter) !== counter) throw bad('Order counter is stale. Refresh and try again.');

  for (const item of [...p.offer, ...p.consideration]) {
    if (big(item.startAmount) !== big(item.endAmount)) throw bad('Auctions are not supported');
  }

  const offer = p.offer;
  const cons = p.consideration;
  let row;

  if (offer.length === 1 && Number(offer[0].itemType) === ItemType.ERC721) {
    // Listing: NFT for native ETH
    const nft = offer[0];
    if (lc(nft.token) !== collection.address) throw bad('Order is for a different collection');
    if (cons.some((c) => Number(c.itemType) !== ItemType.NATIVE)) throw bad('Listings must be priced in ETH');
    if (lc(cons[0].recipient) !== maker) throw bad('First payment must go to the seller');
    const price = cons.reduce((s, c) => s + big(c.startAmount), 0n);
    checkFees(cons, price, collection);
    const tokenId = big(nft.identifierOrCriteria).toString();
    const [owner, approved] = await Promise.all([
      erc721(collection.address).ownerOf(tokenId),
      erc721(collection.address).isApprovedForAll(maker, config.seaport),
    ]);
    if (lc(owner) !== maker) throw bad('You no longer own this item');
    if (!approved) throw bad('Approve the marketplace to transfer this collection first');
    row = { kind: 'listing', tokenId, price, currency: 'ETH' };
  } else if (offer.length === 1 && Number(offer[0].itemType) === ItemType.ERC20) {
    // Offer: WETH for an NFT (single token or any token in the collection)
    const pay = offer[0];
    if (lc(pay.token) !== config.weth) throw bad('Offers must be made in WETH');
    const nft = cons[0];
    if (lc(nft.token) !== collection.address) throw bad('Order is for a different collection');
    if (lc(nft.recipient) !== maker) throw bad('NFT must go to the offer maker');
    const price = big(pay.startAmount);
    const fees = cons.slice(1);
    if (fees.some((c) => Number(c.itemType) !== ItemType.ERC20 || lc(c.token) !== config.weth)) throw bad('Offer fees must be in WETH');
    checkFees([{ recipient: maker, startAmount: '0' }, ...fees], price, collection);
    let kind;
    let tokenId = null;
    if (Number(nft.itemType) === ItemType.ERC721) {
      kind = 'offer';
      tokenId = big(nft.identifierOrCriteria).toString();
    } else if (Number(nft.itemType) === ItemType.ERC721_WITH_CRITERIA && big(nft.identifierOrCriteria) === 0n) {
      kind = 'collection_offer';
    } else throw bad('Unsupported offer type');
    const [bal, allowance] = await Promise.all([erc20(config.weth).balanceOf(maker), erc20(config.weth).allowance(maker, config.seaport)]);
    if (bal < price) throw bad('Not enough WETH for this offer. Wrap more ETH first.');
    if (allowance < price) throw bad('Approve WETH for the marketplace first');
    row = { kind, tokenId, price, currency: 'WETH' };
  } else {
    throw bad('Unsupported order shape');
  }

  return {
    ...row,
    hash: orderHash(p),
    maker,
    counter: big(p.counter).toString(),
    startTime: new Date(Number(p.startTime) * 1000),
    endTime: new Date(Number(p.endTime) * 1000),
  };
}

function checkFees(cons, price, collection) {
  const paidTo = (addr) => cons.filter((c) => lc(c.recipient) === addr).reduce((s, c) => s + big(c.startAmount), 0n);
  if (config.feeVault && config.marketFeeBps > 0) {
    const need = (price * BigInt(config.marketFeeBps)) / 10000n;
    if (paidTo(config.feeVault) < need) throw bad('Order is missing the marketplace fee', 'fee');
  }
  if (collection.royalty_bps > 0 && collection.royalty_receiver) {
    const need = (price * BigInt(collection.royalty_bps)) / 10000n;
    if (paidTo(lc(collection.royalty_receiver)) < need) throw bad('Order is missing the creator royalty', 'royalty');
  }
}
