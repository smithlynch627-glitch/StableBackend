// StableMarket orders: EIP-712 hashing and validation against the contract itself.
import { TypedDataEncoder, isAddress } from 'ethers';
import { config } from '../config.js';
import { bad } from './http.js';
import { market } from './chain.js';

export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'side', type: 'uint8' },
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'anyToken', type: 'bool' },
    { name: 'price', type: 'uint256' },
    { name: 'maxFeeBps', type: 'uint16' },
    { name: 'maxRoyaltyBps', type: 'uint16' },
    { name: 'expiry', type: 'uint64' },
    { name: 'salt', type: 'uint256' },
    { name: 'counter', type: 'uint256' },
  ],
};

export const domain = () => ({ name: 'STABLE Market', version: '1', chainId: config.chainId, verifyingContract: config.market });

const STATUS = [
  'Fillable',
  'This order was already filled or cancelled',
  'This order has expired',
  'This order was cancelled (counter changed)',
  'The signature is not valid for this order',
  'This collection cannot be traded on this marketplace',
  'Price must be greater than 0',
  'The marketplace fee changed. Sign a new order.',
  'The creator royalty changed. Sign a new order.',
  'You do not own this item',
  'Approve the marketplace to transfer this collection first',
  'Not enough WETH for this offer',
  'Approve WETH for the marketplace first',
  'The marketplace is paused',
  'Invalid order',
];

/** Normalises the JSON order from the browser into the exact typed-data values. */
export function normalizeOrder(o) {
  const need = ['maker', 'side', 'collection', 'tokenId', 'anyToken', 'price', 'maxFeeBps', 'maxRoyaltyBps', 'expiry', 'salt', 'counter'];
  if (!o || typeof o !== 'object' || need.some((k) => o[k] === undefined)) throw bad('Malformed order');
  if (!isAddress(o.maker) || !isAddress(o.collection)) throw bad('Malformed order address');
  const n = {
    maker: String(o.maker).toLowerCase(),
    side: Number(o.side),
    collection: String(o.collection).toLowerCase(),
    tokenId: BigInt(o.tokenId).toString(),
    anyToken: Boolean(o.anyToken),
    price: BigInt(o.price).toString(),
    maxFeeBps: Number(o.maxFeeBps),
    maxRoyaltyBps: Number(o.maxRoyaltyBps),
    expiry: BigInt(o.expiry).toString(),
    salt: BigInt(o.salt).toString(),
    counter: BigInt(o.counter).toString(),
  };
  if (![0, 1].includes(n.side)) throw bad('Invalid order side');
  if (n.side === 0 && n.anyToken) throw bad('Listings must be for one item');
  return n;
}

export const orderHash = (o) => TypedDataEncoder.hash(domain(), ORDER_TYPES, o).toLowerCase();

/** Checks an order with the marketplace contract (signature, counter, expiry, fees, ownership, approvals, WETH). */
export async function validateOrder(raw, signature) {
  if (!config.market) throw bad('Marketplace contract is not configured', 'not_ready');
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw bad('Missing signature');
  const o = normalizeOrder(raw);
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(o.price) <= 0n) throw bad('Price must be greater than 0');
  if (Number(o.expiry) <= now + 60) throw bad('Order expires too soon');
  if (Number(o.expiry) > now + 181 * 86400) throw bad('Orders can last at most 180 days');

  const hash = orderHash(o);
  const onchainHash = String(await market().hashOrder(toTuple(o))).toLowerCase();
  if (onchainHash !== hash) throw bad('Order hash mismatch (wrong chain or contract)');

  const status = Number(await market().checkOrder(toTuple(o), signature, o.anyToken ? 0 : o.tokenId, '0x0000000000000000000000000000000000000000'));
  if (status !== 0) throw bad(STATUS[status] || 'Order is not valid', `status_${status}`);
  return { order: o, hash };
}

export const toTuple = (o) => [o.maker, o.side, o.collection, o.tokenId, o.anyToken, o.price, o.maxFeeBps, o.maxRoyaltyBps, o.expiry, o.salt, o.counter];
