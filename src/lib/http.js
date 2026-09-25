import { isAddress, parseEther } from 'ethers';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (msg, code = 'bad_request') => new HttpError(400, msg, code);
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg, 'forbidden');

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function addrParam(v, name = 'address') {
  if (!v || !isAddress(String(v))) throw bad(`Invalid ${name}`, 'invalid_address');
  return String(v).toLowerCase();
}

export function tokenIdParam(v) {
  if (v === undefined || v === null || !/^\d{1,78}$/.test(String(v))) throw bad('Invalid token id', 'invalid_token');
  return String(v);
}

export function ethToWei(v) {
  try {
    const wei = parseEther(String(v));
    if (wei <= 0n) throw new Error();
    return wei.toString();
  } catch {
    throw bad('Enter a price greater than 0', 'invalid_price');
  }
}

export const clampInt = (v, min, max, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export const randomHash = () =>
  '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
