/**
 * Select nearest/deepest anchor candidate around a boundary.
 * Candidate shape: { side, band } where band has center/priceRange/notionalUsd.
 */
export function selectAnchor(candidates = [], boundary = null, opts = {}) {
  const topN = Number.isFinite(Number(opts?.topN)) ? Math.max(1, Math.floor(Number(opts.topN))) : 3;
  const maxDistance = Number.isFinite(Number(opts?.maxDistance)) ? Number(opts.maxDistance) : null;
  const rejectReasons = [];

  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const side = candidate?.side ?? null;
      const band = candidate?.band ?? {};
      const center = Number(band?.center);
      if (!Number.isFinite(center)) return null;
      const distance = Number.isFinite(Number(boundary)) ? Math.abs(center - Number(boundary)) : null;
      const depth = Number(band?.notionalUsd ?? band?.thickness ?? 0);
      return {
        side,
        band,
        price: center,
        priceRange: Array.isArray(band?.priceRange) ? band.priceRange : null,
        depth: Number.isFinite(depth) ? depth : 0,
        distance: Number.isFinite(distance) ? distance : null
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    rejectReasons.push('no_candidates');
    return { anchor: null, rejectReasons, candidateDistance: null };
  }

  const withinDistance = normalized.filter((item) => {
    if (maxDistance == null) return true;
    if (!Number.isFinite(item.distance)) return false;
    return item.distance <= maxDistance;
  });
  if (withinDistance.length === 0) {
    rejectReasons.push('distance_exceeded');
    return { anchor: null, rejectReasons, candidateDistance: null };
  }

  const byDistance = [...withinDistance].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const shortlisted = byDistance.slice(0, topN);
  shortlisted.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  const picked = shortlisted[0];
  const depthRank = [...shortlisted].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))
    .findIndex((item) => item === picked) + 1;
  const distanceRank = byDistance.findIndex((item) => item === picked) + 1;

  return {
    anchor: {
      side: picked.side,
      band: picked.band,
      price: picked.price,
      priceRange: picked.priceRange,
      depth: picked.depth,
      distance: picked.distance,
      depthRank,
      distanceRank,
      chosenReason: 'nearest_topN_by_depth'
    },
    rejectReasons,
    candidateDistance: picked.distance
  };
}
