/** Work out which phase is live and the overall drop status from the phases JSON. */
export function dropState(phases, totalSupply, maxSupply, now = Date.now()) {
  const soldOut = maxSupply != null && maxSupply > 0 && totalSupply >= maxSupply;
  const list = (phases || []).map((p, index) => {
    const start = new Date(p.start).getTime();
    const end = p.end ? new Date(p.end).getTime() : Infinity;
    // Same rule as the contract: live from start, closed at end. A sold-out drop has no open phase.
    const status = soldOut || now >= end ? 'ended' : now < start ? 'upcoming' : 'live';
    return { ...p, index, status };
  });
  const live = soldOut ? null : list.find((p) => p.status === 'live') || null;
  const next = list.find((p) => p.status === 'upcoming') || null;
  let status = 'ended';
  if (soldOut) status = 'sold_out';
  else if (live) status = 'live';
  else if (next) status = 'upcoming';
  return { phases: list, status, livePhase: live, nextPhase: next };
}
