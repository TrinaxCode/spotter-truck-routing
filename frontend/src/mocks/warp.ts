export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Maps a point from one origin→destination frame onto another, preserving
 * along-track position and scaling the cross-track offset with trip length.
 * Identity when the two pairs match.
 */
export function warpLngLat(
  lon: number,
  lat: number,
  fromOrigin: LatLon,
  fromDest: LatLon,
  toOrigin: LatLon,
  toDest: LatLon,
): LatLon {
  const cosFrom = Math.cos((fromOrigin.lat * Math.PI) / 180);
  const x = (lon - fromOrigin.lon) * cosFrom;
  const y = lat - fromOrigin.lat;
  const dx = (fromDest.lon - fromOrigin.lon) * cosFrom;
  const dy = fromDest.lat - fromOrigin.lat;
  const srcLen = Math.hypot(dx, dy) || 1;
  const along = (x * dx + y * dy) / (srcLen * srcLen);
  const cross = (x * -dy + y * dx) / srcLen;

  const cosTo = Math.cos((toOrigin.lat * Math.PI) / 180) || 1;
  const tdx = (toDest.lon - toOrigin.lon) * cosTo;
  const tdy = toDest.lat - toOrigin.lat;
  const dstLen = Math.hypot(tdx, tdy) || 1;
  const px = -tdy / dstLen;
  const py = tdx / dstLen;
  const crossScaled = cross * (dstLen / srcLen);
  const ox = along * tdx + crossScaled * px;
  const oy = along * tdy + crossScaled * py;
  return { lon: toOrigin.lon + ox / cosTo, lat: toOrigin.lat + oy };
}
