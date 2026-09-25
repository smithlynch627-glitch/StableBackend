/** Work out which phase is live and the overall drop status from the phases JSON. */
export function dropState(phases, totalSupply, maxSupply, now = Date.now()) {
  const list = (phases || []).map((p, index) => {
    const start = new Date(p.start).getTime();
    const end = p.end ? new Date(p.end).getTime() : Infinity;
    const status = now < start ? 'upcoming' : now > end ? 'ended' : 'live';
    return { ...p, index, status };
  });
  const soldOut = maxSupply != null && totalSupply >= maxSupply;
  const live = soldOut ? null : list.find((p) => p.status === 'live') || null;
  const next = list.find((p) => p.status === 'upcoming') || null;
  let status = 'ended';
  if (soldOut) status = 'sold_out';
  else if (live) status = 'live';
  else if (next) status = 'upcoming';
  return { phases: list, status, livePhase: live, nextPhase: next };
}
