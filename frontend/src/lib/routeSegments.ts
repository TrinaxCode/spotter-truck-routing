import type { RouteOption } from "../api/types";
import { cumulativeMiles, type LngLat } from "./geo";

export interface RouteSegment {
  routeId: string;
  level: number | null;
  checkpointIndex: number;
  coordinates: LngLat[];
}

export function ownershipRanges(
  miles: readonly number[],
  totalMi: number,
): { start: number; end: number }[] {
  return miles.map((mile, index) => ({
    start: index === 0 ? 0 : ((miles[index - 1] ?? mile) + mile) / 2,
    end: index === miles.length - 1 ? totalMi : (mile + (miles[index + 1] ?? mile)) / 2,
  }));
}

/** Splits a route at the owned-mile boundaries so each piece carries one checkpoint level. */
export function segmentRoute(route: RouteOption): RouteSegment[] {
  const coords = route.geometry.coordinates;
  if (coords.length < 2 || route.checkpoints.length === 0) return [];
  const cum = cumulativeMiles(coords);
  const rawTotal = cum[cum.length - 1] || 1;
  const scale = route.distance_mi / rawTotal;
  const scaled = cum.map((mile) => mile * scale);
  const ranges = ownershipRanges(
    route.checkpoints.map((checkpoint) => checkpoint.mile),
    route.distance_mi,
  );

  return ranges
    .map((range, index) => ({
      routeId: route.id,
      level: route.checkpoints[index]?.level ?? null,
      checkpointIndex: route.checkpoints[index]?.index ?? index,
      coordinates: sliceLine(coords, scaled, range.start, range.end),
    }))
    .filter((segment) => segment.coordinates.length >= 2);
}

function sliceLine(
  coords: readonly LngLat[],
  scaled: readonly number[],
  start: number,
  end: number,
): LngLat[] {
  const stop = Math.max(start, end);
  const out: LngLat[] = [pointAt(coords, scaled, start)];
  for (let index = 0; index < coords.length; index += 1) {
    const mile = scaled[index] ?? 0;
    if (mile > start && mile < stop) out.push(coords[index]);
  }
  out.push(pointAt(coords, scaled, stop));
  return dedupe(out);
}

function pointAt(coords: readonly LngLat[], scaled: readonly number[], mile: number): LngLat {
  const last = coords.length - 1;
  if (last <= 0) return coords[0];
  if (mile <= (scaled[0] ?? 0)) return coords[0];
  if (mile >= (scaled[last] ?? 0)) return coords[last];
  let index = 1;
  while (index < scaled.length && (scaled[index] ?? 0) < mile) index += 1;
  const startMile = scaled[index - 1] ?? 0;
  const endMile = scaled[index] ?? startMile;
  const t = (mile - startMile) / (endMile - startMile || 1);
  const a = coords[index - 1];
  const b = coords[index];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function dedupe(coords: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const coord of coords) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== coord[0] || prev[1] !== coord[1]) out.push(coord);
  }
  return out;
}
