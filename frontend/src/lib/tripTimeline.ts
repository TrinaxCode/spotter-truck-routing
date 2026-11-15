import type { RouteOption } from "../api/types";
import { cumulativeMiles, type LngLat } from "./geo";

/**
 * Where the truck is at any moment of a planned trip (SPEC §12.3), built only from what the plan
 * already says: checkpoint miles and ETAs, the HOS breaks and the route geometry.
 *
 * Checkpoint ETAs include the breaks, so a straight line between two ETAs would drag the truck
 * through a 30-minute stop. Instead the breaks are taken off the clock: "driving time" is what is
 * left of elapsed time once every stop has been removed, miles are interpolated on that axis, and
 * during a stop the driving time (and so the truck) stands still.
 */

export type StopKind = "break" | "rest";

export interface TripStop {
  kind: StopKind;
  /** "30-min break" or "10-h rest". */
  label: string;
  /** Mile where the truck stands, read off the driving-time axis so it never jumps. */
  mile: number;
  startMs: number;
  endMs: number;
}

export interface Timeline {
  startMs: number;
  endMs: number;
  distanceMi: number;
  stops: TripStop[];
  /** Checkpoint ETAs, one per `route.checkpoints` entry. */
  checkpointMs: number[];
  checkpointMiles: number[];
  /** Route polyline with miles scaled to the provider's distance. */
  coords: LngLat[];
  scaledMiles: number[];
  /** Interpolation knots: driving milliseconds (stops removed) against route mile. */
  knotDrive: number[];
  knotMile: number[];
}

export interface TripSample {
  tMs: number;
  mile: number;
  lon: number;
  lat: number;
  /** Degrees clockwise from north along the direction of travel. */
  bearing: number;
  /** The stop in progress, if the truck is standing still. */
  stop: TripStop | null;
  /** Index into `route.checkpoints` of the checkpoint that owns the truck's mile. */
  checkpoint: number;
  /** 0..1 of the trip's wall-clock span. */
  progress: number;
}

function stopFrom(
  item: RouteOption["summary"]["breaks"][number],
): { kind: StopKind; label: string; startMs: number; endMs: number } | null {
  const startMs = Date.parse(item.start);
  const endMs = Date.parse(item.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
  const rest = item.type.startsWith("off_duty") || endMs - startMs >= 4 * 3_600_000;
  return { kind: rest ? "rest" : "break", label: rest ? "10-h rest" : "30-min break", startMs, endMs };
}

/** Largest index `i` with `values[i] <= value`, or 0. `values` must be ascending. */
function floorIndex(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (values[mid] <= value) low = mid;
    else high = mid - 1;
  }
  return low;
}

function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last];
  const i = floorIndex(xs, x);
  const span = xs[i + 1] - xs[i];
  if (span <= 0) return ys[i];
  return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / span;
}

export function buildTimeline(route: RouteOption): Timeline {
  const startMs = Date.parse(route.departure);
  const lastCheckpoint = route.checkpoints[route.checkpoints.length - 1];
  const arrival = Date.parse(route.arrival);
  const endMs = Math.max(
    Number.isNaN(arrival) ? startMs : arrival,
    lastCheckpoint ? Date.parse(lastCheckpoint.eta) || startMs : startMs,
  );
  const distanceMi = route.distance_mi;
  const coords = route.geometry.coordinates as LngLat[];
  const cum = cumulativeMiles(coords);
  const raw = cum[cum.length - 1] || 1;
  const scaledMiles = cum.map((mile) => (mile * distanceMi) / raw);

  const stops: TripStop[] = [];
  const pending = route.summary.breaks
    .map(stopFrom)
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.startMs - b.startMs);

  const checkpointMs = route.checkpoints.map((checkpoint) => Date.parse(checkpoint.eta));
  const checkpointMiles = route.checkpoints.map((checkpoint) => checkpoint.mile);
  const stoppedBefore = (t: number) =>
    pending.reduce((sum, item) => sum + Math.max(0, Math.min(t, item.endMs) - item.startMs), 0);

  // Knots: driving time (ETA minus every completed stop) against mile, kept non-decreasing.
  const knotDrive: number[] = [0];
  const knotMile: number[] = [0];
  route.checkpoints.forEach((checkpoint, index) => {
    const eta = checkpointMs[index];
    if (Number.isNaN(eta)) return;
    const drive = Math.max(knotDrive[knotDrive.length - 1], eta - startMs - stoppedBefore(eta));
    if (checkpoint.mile <= knotMile[knotMile.length - 1] && drive <= knotDrive[knotDrive.length - 1]) return;
    knotDrive.push(drive);
    knotMile.push(Math.max(knotMile[knotMile.length - 1], checkpoint.mile));
  });
  const totalDrive = Math.max(knotDrive[knotDrive.length - 1], endMs - startMs - stoppedBefore(endMs));
  if (knotMile[knotMile.length - 1] < distanceMi) {
    knotDrive.push(totalDrive);
    knotMile.push(distanceMi);
  }

  for (const item of pending) {
    const drive = item.startMs - startMs - stoppedBefore(item.startMs);
    stops.push({
      kind: item.kind,
      label: item.label,
      mile: interpolate(knotDrive, knotMile, drive),
      startMs: item.startMs,
      endMs: item.endMs,
    });
  }

  return { startMs, endMs, distanceMi, stops, checkpointMs, checkpointMiles, coords, scaledMiles, knotDrive, knotMile };
}

function stoppedUntil(timeline: Timeline, tMs: number): number {
  let total = 0;
  for (const stop of timeline.stops) {
    if (tMs > stop.startMs) total += Math.min(tMs, stop.endMs) - stop.startMs;
  }
  return total;
}

/** Index of the checkpoint closest to a mile (ties go to the later one, as ownership does). */
export function nearestCheckpoint(checkpointMiles: readonly number[], mile: number): number {
  if (checkpointMiles.length === 0) return -1;
  const i = floorIndex(checkpointMiles, mile);
  const next = checkpointMiles[i + 1];
  if (next === undefined) return i;
  return mile - checkpointMiles[i] < next - mile ? i : i + 1;
}

/** Position and bearing at a mile along the polyline. */
export function locate(timeline: Timeline, mile: number): { lon: number; lat: number; bearing: number } {
  const { coords, scaledMiles } = timeline;
  if (coords.length === 0) return { lon: 0, lat: 0, bearing: 0 };
  if (coords.length === 1) return { lon: coords[0][0], lat: coords[0][1], bearing: 0 };
  const m = Math.min(Math.max(mile, 0), scaledMiles[scaledMiles.length - 1]);
  const upper = Math.min(coords.length - 1, Math.max(1, floorIndex(scaledMiles, m) + 1));
  const a = coords[upper - 1];
  const b = coords[upper];
  const span = scaledMiles[upper] - scaledMiles[upper - 1];
  const t = span > 0 ? (m - scaledMiles[upper - 1]) / span : 0;
  const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const bearing = ((Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
  return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, bearing };
}

export function sampleTimeline(timeline: Timeline, tMs: number): TripSample {
  const t = Math.min(Math.max(tMs, timeline.startMs), timeline.endMs);
  const stop = timeline.stops.find((item) => t >= item.startMs && t < item.endMs) ?? null;
  const drive = t - timeline.startMs - stoppedUntil(timeline, t);
  const mile = stop ? stop.mile : interpolate(timeline.knotDrive, timeline.knotMile, drive);
  const span = timeline.endMs - timeline.startMs;
  return {
    tMs: t,
    mile,
    ...locate(timeline, mile),
    stop,
    checkpoint: nearestCheckpoint(timeline.checkpointMiles, mile),
    progress: span > 0 ? (t - timeline.startMs) / span : 1,
  };
}

/** When the truck first reaches a mile (before any stop that happens at that mile). */
export function timeAtMile(timeline: Timeline, mile: number): number {
  const m = Math.min(Math.max(mile, 0), timeline.distanceMi);
  const drive = interpolate(timeline.knotMile, timeline.knotDrive, m);
  let stopped = 0;
  for (const stop of timeline.stops) {
    const at = interpolate(timeline.knotMile, timeline.knotDrive, stop.mile);
    if (at < drive) stopped += stop.endMs - stop.startMs;
  }
  return timeline.startMs + drive + stopped;
}

/** Heatmap frame (0..max) that shows the truck's hour: the nearest forecast hour, clamped. */
export function frameHour(heatStartMs: number, tMs: number, max = 48): number {
  if (Number.isNaN(heatStartMs)) return 0;
  return Math.min(max, Math.max(0, Math.round((tMs - heatStartMs) / 3_600_000)));
}
