export function computeChannelWidth(upper, lower) {
  const u = Number(upper);
  const l = Number(lower);
  if (!Number.isFinite(u) || !Number.isFinite(l)) return null;
  const w = u - l;
  return Number.isFinite(w) && w > 0 ? w : null;
}

export function computeMinBandDistance(channelWidth) {
  const w = Number(channelWidth);
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.max(8, w * 0.12);
}
