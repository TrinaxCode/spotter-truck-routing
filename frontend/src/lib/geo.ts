const EARTH_MI = 3958.7613;

export type LngLat = [number, number];

export function haversineMi(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function cumulativeMiles(coords: readonly LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i += 1) {
    cum.push(cum[i - 1] + haversineMi(coords[i - 1], coords[i]));
  }
  return cum;
}

/** Miles of route owned by each checkpoint. Endpoints keep the outer half-gap. */
export function ownedMiles(checkpointMiles: readonly number[], totalMi: number): number[] {
  return checkpointMiles.map((mile, index) => {
    const start = index === 0 ? 0 : (checkpointMiles[index - 1] + mile) / 2;
    const end =
      index === checkpointMiles.length - 1 ? totalMi : (mile + checkpointMiles[index + 1]) / 2;
    return Math.max(0, end - start);
  });
}

export function pointAlong(coords: readonly LngLat[], cum: readonly number[], mile: number): LngLat {
  const total = cum[cum.length - 1] ?? 0;
  if (coords.length === 0) return [0, 0];
  if (mile <= 0 || total === 0) return coords[0];
  if (mile >= total) return coords[coords.length - 1];
  let index = 1;
  while (index < cum.length && cum[index] < mile) index += 1;
  const startMile = cum[index - 1] ?? 0;
  const endMile = cum[index] ?? startMile;
  const span = endMile - startMile || 1;
  const t = (mile - startMile) / span;
  const a = coords[index - 1];
  const b = coords[index];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function samePoint(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  epsilon = 1e-4,
): boolean {
  return Math.abs(a.lat - b.lat) < epsilon && Math.abs(a.lon - b.lon) < epsilon;
}
