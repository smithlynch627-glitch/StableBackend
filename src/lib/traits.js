// Deterministic STABLE COWS trait generator for test mode.
// Replace with real metadata (tokenURI JSON) once the art is uploaded to IPFS.

const TABLE = {
  Background: [['Paper', 30], ['Ink', 18], ['Fog', 24], ['Roof Tile', 16], ['Hanji', 12]],
  Hide: [['Classic Spots', 34], ['Big Patch', 20], ['Freckles', 18], ['Midnight', 12], ['Ghost', 10], ['Marble', 6]],
  Horns: [['Short', 38], ['Long', 26], ['Curled', 16], ['None', 12], ['Chrome', 8]],
  Eyes: [['Calm', 34], ['Sleepy', 26], ['Wide', 20], ['Shades', 12], ['Wink', 8]],
  Outfit: [['None', 28], ['Hoodie', 20], ['STABLE Tee', 18], ['Hanbok', 13], ['Suit', 11], ['Varsity', 10]],
  Accessory: [['None', 44], ['Nose Ring', 20], ['Bell', 16], ['Earring', 11], ['Headphones', 9]],
};

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, options) {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of options) {
    if ((r -= w) <= 0) return value;
  }
  return options[options.length - 1][0];
}

export function cowAttributes(tokenId) {
  const rand = mulberry32(Number(tokenId) * 2654435761);
  return Object.entries(TABLE).map(([trait_type, options]) => ({ trait_type, value: pick(rand, options) }));
}

const rankCache = new Map();

/** Rarity rank (1 = rarest) across the full supply, using summed inverse trait frequency. */
export function cowRarityRanks(maxSupply) {
  if (rankCache.has(maxSupply)) return rankCache.get(maxSupply);
  const all = [];
  for (let id = 1; id <= maxSupply; id++) all.push({ id, attrs: cowAttributes(id) });
  const freq = {};
  for (const { attrs } of all) for (const a of attrs) freq[`${a.trait_type}:${a.value}`] = (freq[`${a.trait_type}:${a.value}`] || 0) + 1;
  const scored = all.map(({ id, attrs }) => ({ id, score: attrs.reduce((s, a) => s + maxSupply / freq[`${a.trait_type}:${a.value}`], 0) }));
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  const ranks = new Map(scored.map((s, i) => [s.id, i + 1]));
  rankCache.set(maxSupply, ranks);
  return ranks;
}
