/**
 * Pure math behind the animated weather layer: the per-cell wind/rain/snow field, bilinear sampling,
 * the "from" -> "towards" wind convention, particle advection / respawn / clipping, spawn densities
 * and the ground -> screen mapping. No DOM, no MapLibre: everything works on typed arrays so the
 * engine (src/map/weatherAnimation.ts) can reuse its buffers and tests can run in plain node.
 */
import type { HeatmapResponse } from "../api/types";
import { RAMPS, type ContinuousVariable } from "./heatmap";

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG (mulberry32): stable visuals between runs and reproducible tests. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Web Mercator in normalised world units (0..1 across the world)
// ---------------------------------------------------------------------------------------------

export function lonToMercX(lon: number): number {
  return (lon + 180) / 360;
}

export function latToMercY(lat: number): number {
  const clamped = clamp(lat, -85.0511, 85.0511);
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)) / (2 * Math.PI);
}

export function mercXToLon(x: number): number {
  return x * 360 - 180;
}

export function mercYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) / DEG;
}

/** MapLibre's world size in CSS px at a zoom (512 px tiles). */
export function worldSizePx(zoom: number): number {
  return 512 * 2 ** zoom;
}

// ---------------------------------------------------------------------------------------------
// Wind vectors
// ---------------------------------------------------------------------------------------------

export interface Vec2 {
  u: number;
  v: number;
}

/**
 * Meteorological direction is where the wind blows FROM (270 = from the west). The vector returned
 * is where it blows TOWARDS: u = east component, v = north component, in the same unit as `speed`.
 */
export function windVector(speed: number, fromDeg: number, out: Vec2 = { u: 0, v: 0 }): Vec2 {
  const rad = fromDeg * DEG;
  out.u = -speed * Math.sin(rad);
  out.v = -speed * Math.cos(rad);
  return out;
}

/** Inverse of `windVector`: the "from" bearing (0..360) of a towards vector. */
export function windFromDegrees(u: number, v: number): number {
  const deg = Math.atan2(-u, -v) / DEG;
  return (deg + 360) % 360;
}

/**
 * Direction used when the backend sends no `wind_dir`: a gentle westerly with a slow swell across
 * the map so the flow reads as air, not as a parallel hatch. Deterministic in (lon, lat).
 */
export function fallbackWindFrom(lon: number, lat: number): number {
  return 268 + 22 * Math.sin(lat * 0.55 + lon * 0.23) + 12 * Math.sin(lon * 0.41 - lat * 0.31 + 1.7);
}

// ---------------------------------------------------------------------------------------------
// Ramp colours (reuse the heatmap ramps so particles match the fill beneath them)
// ---------------------------------------------------------------------------------------------

type Rgb = [number, number, number];
interface ParsedRamp {
  values: number[];
  rgb: Rgb[];
}

const parsedRamps: Partial<Record<ContinuousVariable, ParsedRamp>> = {};

function parseHex(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.replace(/./g, "$&$&") : clean;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function parsedRamp(variable: ContinuousVariable): ParsedRamp {
  let parsed = parsedRamps[variable];
  if (!parsed) {
    const stops = RAMPS[variable].stops;
    parsed = { values: stops.map(([value]) => value), rgb: stops.map(([, color]) => parseHex(color)) };
    parsedRamps[variable] = parsed;
  }
  return parsed;
}

/** Linear interpolation of a heatmap ramp, written into `out` as 0..255 channels. */
export function rampRgb(variable: ContinuousVariable, value: number, out: Rgb = [0, 0, 0]): Rgb {
  const { values, rgb } = parsedRamp(variable);
  const last = values.length - 1;
  if (!(value > values[0])) {
    out[0] = rgb[0][0]; out[1] = rgb[0][1]; out[2] = rgb[0][2];
    return out;
  }
  if (value >= values[last]) {
    out[0] = rgb[last][0]; out[1] = rgb[last][1]; out[2] = rgb[last][2];
    return out;
  }
  let k = 1;
  while (value > values[k]) k += 1;
  const t = (value - values[k - 1]) / (values[k] - values[k - 1]);
  for (let c = 0; c < 3; c += 1) out[c] = rgb[k - 1][c] + (rgb[k][c] - rgb[k - 1][c]) * t;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cell grid: the backend sends a regular lat/lon grid as a flat list of cell centres
// ---------------------------------------------------------------------------------------------

export interface GridCell {
  lat: number;
  lon: number;
}

export interface CellGrid {
  cellDeg: number;
  /** Centre longitude / latitude of grid column 0 / row 0. */
  lon0: number;
  lat0: number;
  nx: number;
  ny: number;
  /** slot (j * nx + i) -> index into `cells`, or -1 where the corridor has no cell. */
  lookup: Int32Array;
  /** cell index -> slot. */
  slotOfCell: Int32Array;
  cellCount: number;
}

const MAX_GRID_SLOTS = 1_500_000;

/** Snaps cell centres onto a regular grid. Returns null for no cells or an absurd extent. */
export function buildGrid(cells: readonly GridCell[], cellDeg: number): CellGrid | null {
  if (cells.length === 0 || !(cellDeg > 0) || !Number.isFinite(cellDeg)) return null;
  let lon0 = Infinity;
  let lat0 = Infinity;
  for (const cell of cells) {
    if (!Number.isFinite(cell.lat) || !Number.isFinite(cell.lon)) return null;
    if (cell.lon < lon0) lon0 = cell.lon;
    if (cell.lat < lat0) lat0 = cell.lat;
  }
  let nx = 1;
  let ny = 1;
  const slotOfCell = new Int32Array(cells.length);
  const ij = new Int32Array(cells.length * 2);
  for (let c = 0; c < cells.length; c += 1) {
    const i = Math.round((cells[c].lon - lon0) / cellDeg);
    const j = Math.round((cells[c].lat - lat0) / cellDeg);
    ij[c * 2] = i;
    ij[c * 2 + 1] = j;
    if (i + 1 > nx) nx = i + 1;
    if (j + 1 > ny) ny = j + 1;
  }
  if (nx * ny > MAX_GRID_SLOTS) return null;
  const lookup = new Int32Array(nx * ny).fill(-1);
  for (let c = 0; c < cells.length; c += 1) {
    const slot = ij[c * 2 + 1] * nx + ij[c * 2];
    slotOfCell[c] = slot;
    lookup[slot] = c;
  }
  return { cellDeg, lon0, lat0, nx, ny, lookup, slotOfCell, cellCount: cells.length };
}

export function slotLon(grid: CellGrid, slot: number): number {
  return grid.lon0 + (slot % grid.nx) * grid.cellDeg;
}

export function slotLat(grid: CellGrid, slot: number): number {
  return grid.lat0 + Math.floor(slot / grid.nx) * grid.cellDeg;
}

/** Slot of the cell that contains a point, or -1 outside the corridor. */
export function slotAt(grid: CellGrid, lon: number, lat: number): number {
  const i = Math.round((lon - grid.lon0) / grid.cellDeg);
  const j = Math.round((lat - grid.lat0) / grid.cellDeg);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return -1;
  const slot = j * grid.nx + i;
  return grid.lookup[slot] >= 0 ? slot : -1;
}

// ---------------------------------------------------------------------------------------------
// The per-hour field, stored in grid layout so sampling never goes through the cell list
// ---------------------------------------------------------------------------------------------

export interface WindField {
  grid: CellGrid;
  /** Towards-vector, mph: east and north. */
  u: Float32Array;
  v: Float32Array;
  speed: Float32Array;
  rain: Float32Array;
  snow: Float32Array;
  /** 1 where the slot has a cell AND a wind value for this hour. */
  windOk: Uint8Array;
  /** Cells whose direction came from the data (not the fallback) in the last fill. */
  realDirections: number;
}

export function createField(grid: CellGrid): WindField {
  const slots = grid.nx * grid.ny;
  return {
    grid,
    u: new Float32Array(slots),
    v: new Float32Array(slots),
    speed: new Float32Array(slots),
    rain: new Float32Array(slots),
    snow: new Float32Array(slots),
    windOk: new Uint8Array(slots),
    realDirections: 0,
  };
}

type Row = readonly (number | null)[] | undefined;

function at(row: Row, hour: number): number | null {
  const value = row?.[hour];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type FieldSource = Pick<HeatmapResponse, "wind" | "rain" | "snow"> & { wind_dir?: HeatmapResponse["wind_dir"] };

const scratchA: Vec2 = { u: 0, v: 0 };
const scratchB: Vec2 = { u: 0, v: 0 };

/**
 * Writes the field for an hour into `field` in place. `hour` may be fractional (the two frames are
 * blended). Null wind -> no particles in that cell; null wind_dir -> the gentle fallback direction;
 * null rain/snow -> dry. Nothing is allocated.
 */
export function fillField(field: WindField, data: FieldSource, hour: number): void {
  const { grid } = field;
  field.u.fill(0);
  field.v.fill(0);
  field.speed.fill(0);
  field.rain.fill(0);
  field.snow.fill(0);
  field.windOk.fill(0);
  field.realDirections = 0;

  const clampedHour = Number.isFinite(hour) ? Math.max(0, hour) : 0;
  const h0 = Math.floor(clampedHour);
  const frac = clampedHour - h0;
  const h1 = frac > 1e-3 ? h0 + 1 : h0;

  for (let c = 0; c < grid.cellCount; c += 1) {
    const slot = grid.slotOfCell[c];
    const lon = slotLon(grid, slot);
    const lat = slotLat(grid, slot);

    const s0 = at(data.wind[c], h0);
    const s1 = h1 === h0 ? s0 : at(data.wind[c], h1);
    if (s0 !== null || s1 !== null) {
      const d0 = at(data.wind_dir?.[c], h0);
      const d1 = h1 === h0 ? d0 : at(data.wind_dir?.[c], h1);
      if (d0 !== null || d1 !== null) field.realDirections += 1;
      const fallback = fallbackWindFrom(lon, lat);
      const a = s0 !== null ? windVector(Math.max(0, s0), d0 ?? d1 ?? fallback, scratchA) : null;
      const b = s1 !== null ? windVector(Math.max(0, s1), d1 ?? d0 ?? fallback, scratchB) : null;
      if (a && b) {
        field.u[slot] = a.u + (b.u - a.u) * frac;
        field.v[slot] = a.v + (b.v - a.v) * frac;
        field.speed[slot] = Math.max(0, s0 as number) + (Math.max(0, s1 as number) - Math.max(0, s0 as number)) * frac;
      } else {
        const only = (a ?? b) as Vec2;
        field.u[slot] = only.u;
        field.v[slot] = only.v;
        field.speed[slot] = Math.max(0, (s0 ?? s1) as number);
      }
      field.windOk[slot] = 1;
    }

    const r0 = at(data.rain[c], h0) ?? 0;
    const r1 = h1 === h0 ? r0 : (at(data.rain[c], h1) ?? 0);
    field.rain[slot] = Math.max(0, r0 + (r1 - r0) * frac);
    const n0 = at(data.snow[c], h0) ?? 0;
    const n1 = h1 === h0 ? n0 : (at(data.snow[c], h1) ?? 0);
    field.snow[slot] = Math.max(0, n0 + (n1 - n0) * frac);
  }
}

export function copyField(target: WindField, source: WindField): void {
  target.u.set(source.u);
  target.v.set(source.v);
  target.speed.set(source.speed);
  target.rain.set(source.rain);
  target.snow.set(source.snow);
  target.windOk.set(source.windOk);
  target.realDirections = source.realDirections;
}

/**
 * Moves `current` a fraction `k` (0..1) towards `target`, so scrubbing the hour glides instead of
 * popping. Validity follows the target at once; a cell that just became valid snaps. Returns true
 * while the two fields still differ noticeably.
 */
export function easeField(current: WindField, target: WindField, k: number): boolean {
  let moving = false;
  const slots = current.u.length;
  for (let s = 0; s < slots; s += 1) {
    if (!target.windOk[s]) {
      current.windOk[s] = 0;
      current.u[s] = 0;
      current.v[s] = 0;
      current.speed[s] = 0;
    } else if (!current.windOk[s]) {
      current.windOk[s] = 1;
      current.u[s] = target.u[s];
      current.v[s] = target.v[s];
      current.speed[s] = target.speed[s];
    } else {
      const du = target.u[s] - current.u[s];
      const dv = target.v[s] - current.v[s];
      const ds = target.speed[s] - current.speed[s];
      current.u[s] += du * k;
      current.v[s] += dv * k;
      current.speed[s] += ds * k;
      if (Math.abs(du) + Math.abs(dv) + Math.abs(ds) > 0.05) moving = true;
    }
    const dr = target.rain[s] - current.rain[s];
    const dn = target.snow[s] - current.snow[s];
    current.rain[s] += dr * k;
    current.snow[s] += dn * k;
    if (Math.abs(dr) > 0.002 || Math.abs(dn) > 0.002) moving = true;
  }
  return moving;
}

// ---------------------------------------------------------------------------------------------
// Bilinear sampling
// ---------------------------------------------------------------------------------------------

export interface WindSample extends Vec2 {
  /** Interpolated speed (mph) for colour and density, not the magnitude of (u, v). */
  speed: number;
}

/**
 * Bilinear wind at a point. The containing cell must carry wind (otherwise false: the point is
 * outside the corridor or the cell has no forecast); neighbours without wind are left out and the
 * remaining weights renormalised, so the field fades to the data edge instead of to zero.
 */
export function sampleWind(field: WindField, lon: number, lat: number, out: WindSample): boolean {
  const { grid } = field;
  const fx = (lon - grid.lon0) / grid.cellDeg;
  const fy = (lat - grid.lat0) / grid.cellDeg;
  const ci = Math.round(fx);
  const cj = Math.round(fy);
  if (ci < 0 || cj < 0 || ci >= grid.nx || cj >= grid.ny) return false;
  if (!field.windOk[cj * grid.nx + ci]) return false;

  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  let sumW = 0;
  let u = 0;
  let v = 0;
  let speed = 0;
  for (let dj = 0; dj < 2; dj += 1) {
    const j = j0 + dj;
    if (j < 0 || j >= grid.ny) continue;
    const wy = dj === 0 ? 1 - ty : ty;
    for (let di = 0; di < 2; di += 1) {
      const i = i0 + di;
      if (i < 0 || i >= grid.nx) continue;
      const slot = j * grid.nx + i;
      if (!field.windOk[slot]) continue;
      const w = (di === 0 ? 1 - tx : tx) * wy;
      sumW += w;
      u += field.u[slot] * w;
      v += field.v[slot] * w;
      speed += field.speed[slot] * w;
    }
  }
  if (sumW < 1e-6) return false;
  out.u = u / sumW;
  out.v = v / sumW;
  out.speed = speed / sumW;
  return true;
}

export interface PrecipSample {
  rain: number;
  snow: number;
}

/** Bilinear rain/snow (in/hr) over the cells that exist; false outside the corridor. */
export function samplePrecip(field: WindField, lon: number, lat: number, out: PrecipSample): boolean {
  const { grid } = field;
  const fx = (lon - grid.lon0) / grid.cellDeg;
  const fy = (lat - grid.lat0) / grid.cellDeg;
  const ci = Math.round(fx);
  const cj = Math.round(fy);
  if (ci < 0 || cj < 0 || ci >= grid.nx || cj >= grid.ny) return false;
  if (grid.lookup[cj * grid.nx + ci] < 0) return false;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  let sumW = 0;
  let rain = 0;
  let snow = 0;
  for (let dj = 0; dj < 2; dj += 1) {
    const j = j0 + dj;
    if (j < 0 || j >= grid.ny) continue;
    const wy = dj === 0 ? 1 - ty : ty;
    for (let di = 0; di < 2; di += 1) {
      const i = i0 + di;
      if (i < 0 || i >= grid.nx) continue;
      const slot = j * grid.nx + i;
      if (grid.lookup[slot] < 0) continue;
      const w = (di === 0 ? 1 - tx : tx) * wy;
      sumW += w;
      rain += field.rain[slot] * w;
      snow += field.snow[slot] * w;
    }
  }
  if (sumW < 1e-6) return false;
  out.rain = rain / sumW;
  out.snow = snow / sumW;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Visual mappings: how strong a value looks
// ---------------------------------------------------------------------------------------------

/** Wind speed on screen, CSS px per second. Calm air barely creeps; a gale streams. */
export function visualSpeedPx(mph: number): number {
  return mph <= 0 ? 0 : Math.min(150, 4 + 2.1 * mph);
}

/** Spawn weight 0..1: calm air gets few particles, anything above ~18 mph the full set. */
export function windDensity(mph: number): number {
  if (!(mph > 0.5)) return 0;
  return 0.08 + 0.92 * smoothstep(2.5, 18, mph);
}

/** Opacity 0..1 of a wind trail: low wind is a whisper. */
export function windAlpha(mph: number): number {
  return 0.16 + 0.74 * smoothstep(3, 32, mph);
}

export type PrecipKind = "rain" | "snow";

const PRECIP_FLOOR: Record<PrecipKind, number> = { rain: 0.004, snow: 0.01 };
const PRECIP_FULL: Record<PrecipKind, number> = { rain: 0.5, snow: 1.5 };

/** 0 for dry, then a perceptual curve that reaches 1 in heavy rain (0.5 in/hr) or snow (1.5 in/hr). */
export function precipIntensity(kind: PrecipKind, value: number): number {
  if (!(value > PRECIP_FLOOR[kind])) return 0;
  return Math.max(0.1, Math.sqrt(Math.min(1, value / PRECIP_FULL[kind])));
}

/** Spawn weight for rain or snow; identical to the intensity so streak count scales with it. */
export function precipDensity(kind: PrecipKind, value: number): number {
  return precipIntensity(kind, value);
}

/** Streak length in px for a rain intensity 0..1. */
export function rainStreakPx(intensity: number): number {
  return 7 + 15 * intensity;
}

export const SPEED_BUCKETS = 12;
export const PRECIP_BUCKETS = 4;
const SPEED_BUCKET_MAX_MPH = 55;

export function speedBucket(mph: number): number {
  return clamp(Math.round((mph / SPEED_BUCKET_MAX_MPH) * (SPEED_BUCKETS - 1)), 0, SPEED_BUCKETS - 1);
}

export function speedBucketMph(bucket: number): number {
  return (bucket / (SPEED_BUCKETS - 1)) * SPEED_BUCKET_MAX_MPH;
}

export function precipBucket(intensity: number): number {
  return clamp(Math.floor(intensity * PRECIP_BUCKETS), 0, PRECIP_BUCKETS - 1);
}

/** The ramp value (in/hr) a precip bucket stands for, used to pick its colour. */
export function precipBucketValue(kind: PrecipKind, bucket: number): number {
  const intensity = (bucket + 0.5) / PRECIP_BUCKETS;
  return intensity * intensity * PRECIP_FULL[kind];
}

// ---------------------------------------------------------------------------------------------
// Ground -> screen mapping. A flat Mercator ground plane seen through any pitch/bearing is a
// projective transform, so four screen points unprojected to the ground fix it exactly; after that
// every particle is projected with ~15 flops instead of a MapLibre call.
// ---------------------------------------------------------------------------------------------

export interface ScreenMapping {
  /** Homography (row major, h33 = 1) from local ground px to screen CSS px. */
  h: Float64Array;
  cx: number;
  cy: number;
  scale: number;
  valid: boolean;
}

export function createScreenMapping(): ScreenMapping {
  return { h: new Float64Array(9), cx: 0, cy: 0, scale: 1, valid: false };
}

const dltMatrix = new Float64Array(8 * 9);

/** Solves the 8x8 system in `dltMatrix` (augmented) in place. Returns false when singular. */
function solveDlt(solution: Float64Array): boolean {
  const m = dltMatrix;
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    let best = Math.abs(m[col * 9 + col]);
    for (let row = col + 1; row < 8; row += 1) {
      const candidate = Math.abs(m[row * 9 + col]);
      if (candidate > best) {
        best = candidate;
        pivot = row;
      }
    }
    if (!(best > 1e-12)) return false;
    if (pivot !== col) {
      for (let k = 0; k < 9; k += 1) {
        const tmp = m[col * 9 + k];
        m[col * 9 + k] = m[pivot * 9 + k];
        m[pivot * 9 + k] = tmp;
      }
    }
    for (let row = col + 1; row < 8; row += 1) {
      const factor = m[row * 9 + col] / m[col * 9 + col];
      if (factor === 0) continue;
      for (let k = col; k < 9; k += 1) m[row * 9 + k] -= factor * m[col * 9 + k];
    }
  }
  for (let row = 7; row >= 0; row -= 1) {
    let sum = m[row * 9 + 8];
    for (let k = row + 1; k < 8; k += 1) sum -= m[row * 9 + k] * solution[k];
    solution[row] = sum / m[row * 9 + row];
  }
  return true;
}

const solutionScratch = new Float64Array(8);

/**
 * Fits the mapping from four screen points and the Mercator ground points beneath them
 * (`ground` = x0, y0, x1, y1, ... in world units; `screen` likewise in CSS px).
 * `worldSize` converts world units to px at the current zoom. Returns validity.
 */
export function fitScreenMapping(
  mapping: ScreenMapping,
  screen: ArrayLike<number>,
  ground: ArrayLike<number>,
  worldSize: number,
): boolean {
  mapping.valid = false;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < 4; k += 1) {
    if (!Number.isFinite(ground[k * 2]) || !Number.isFinite(ground[k * 2 + 1])) return false;
    cx += ground[k * 2] / 4;
    cy += ground[k * 2 + 1] / 4;
  }
  mapping.cx = cx;
  mapping.cy = cy;
  mapping.scale = worldSize;
  const m = dltMatrix;
  for (let k = 0; k < 4; k += 1) {
    const a = (ground[k * 2] - cx) * worldSize;
    const b = (ground[k * 2 + 1] - cy) * worldSize;
    const sx = screen[k * 2];
    const sy = screen[k * 2 + 1];
    const r0 = k * 2 * 9;
    const r1 = (k * 2 + 1) * 9;
    m[r0] = a; m[r0 + 1] = b; m[r0 + 2] = 1; m[r0 + 3] = 0; m[r0 + 4] = 0; m[r0 + 5] = 0;
    m[r0 + 6] = -sx * a; m[r0 + 7] = -sx * b; m[r0 + 8] = sx;
    m[r1] = 0; m[r1 + 1] = 0; m[r1 + 2] = 0; m[r1 + 3] = a; m[r1 + 4] = b; m[r1 + 5] = 1;
    m[r1 + 6] = -sy * a; m[r1 + 7] = -sy * b; m[r1 + 8] = sy;
  }
  if (!solveDlt(solutionScratch)) return false;
  for (let k = 0; k < 8; k += 1) {
    if (!Number.isFinite(solutionScratch[k])) return false;
    mapping.h[k] = solutionScratch[k];
  }
  mapping.h[8] = 1;
  mapping.valid = true;
  return true;
}

/** Ground (world units) -> screen px. False when the point is behind the camera plane. */
export function groundToScreen(mapping: ScreenMapping, x: number, y: number, out: Float64Array, offset = 0): boolean {
  const h = mapping.h;
  const a = (x - mapping.cx) * mapping.scale;
  const b = (y - mapping.cy) * mapping.scale;
  const w = h[6] * a + h[7] * b + 1;
  if (!(w > 1e-6)) return false;
  out[offset] = (h[0] * a + h[1] * b + h[2]) / w;
  out[offset + 1] = (h[3] * a + h[4] * b + h[5]) / w;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Spawn tables: where new particles may appear, weighted by density x on-screen area
// ---------------------------------------------------------------------------------------------

export type SpawnKind = "wind" | PrecipKind;

export interface SpawnTable {
  /** Grid slots eligible to spawn into (visible, with density). */
  slots: Int32Array;
  /** Running total of weights, for binary-search picking. */
  cumulative: Float64Array;
  count: number;
  total: number;
}

export function createSpawnTable(capacity: number): SpawnTable {
  return { slots: new Int32Array(capacity), cumulative: new Float64Array(capacity), count: 0, total: 0 };
}

export function densityAt(field: WindField, kind: SpawnKind, slot: number): number {
  if (kind === "wind") return field.windOk[slot] ? windDensity(field.speed[slot]) : 0;
  return precipDensity(kind, kind === "rain" ? field.rain[slot] : field.snow[slot]);
}

/**
 * Rebuilds `table` from the slots currently on screen. `areaPx[k]` is the on-screen area of
 * `visibleSlots[k]`. Returns the summed weight (density x px^2): divide by px-per-particle to get
 * the number of particles the view should hold.
 */
export function fillSpawnTable(
  table: SpawnTable,
  field: WindField,
  kind: SpawnKind,
  visibleSlots: ArrayLike<number>,
  areaPx: ArrayLike<number>,
  visibleCount: number,
): number {
  let total = 0;
  let count = 0;
  const limit = Math.min(visibleCount, table.slots.length);
  for (let k = 0; k < limit; k += 1) {
    const slot = visibleSlots[k];
    const weight = densityAt(field, kind, slot) * areaPx[k];
    if (!(weight > 0)) continue;
    total += weight;
    table.slots[count] = slot;
    table.cumulative[count] = total;
    count += 1;
  }
  table.count = count;
  table.total = total;
  return total;
}

/** Index of the slot a uniform `r` in [0,1) lands on, or -1 for an empty table. */
export function pickSlot(table: SpawnTable, r: number): number {
  if (table.count === 0) return -1;
  const target = r * table.total;
  let lo = 0;
  let hi = table.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.cumulative[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return table.slots[lo];
}

// ---------------------------------------------------------------------------------------------
// Particles (structure of arrays; nothing is allocated after creation)
// ---------------------------------------------------------------------------------------------

export const STATE_IDLE = 0;
export const STATE_ALIVE = 1;
/** The head stopped; the trail retracts until nothing is left. */
export const STATE_DYING = 2;

export interface ParticleSet {
  capacity: number;
  histLen: number;
  state: Uint8Array;
  /** Head on the ground, world units. */
  x: Float64Array;
  y: Float64Array;
  /** Pseudo-height above the ground in px (rain / snow). */
  h: Float32Array;
  age: Float32Array;
  life: Float32Array;
  /** Wind mph at the head (wind) or intensity 0..1 (precip); picks the colour bucket. */
  level: Float32Array;
  /** Static random 0..1 per particle: size, sway phase, speed jitter. */
  seed: Float32Array;
  /** Horizontal slant of a rain streak, px of x per px of height. */
  slant: Float32Array;
  everSpawned: Uint8Array;
  /** Ring buffer of past head positions (world units), newest last written at histHead - 1. */
  hist: Float64Array;
  histN: Uint8Array;
  histHead: Uint8Array;
  histAcc: Float32Array;
}

export function createParticleSet(capacity: number, histLen: number, seed = 7): ParticleSet {
  const rng = createRng(seed);
  const set: ParticleSet = {
    capacity,
    histLen,
    state: new Uint8Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    h: new Float32Array(capacity),
    age: new Float32Array(capacity),
    life: new Float32Array(capacity),
    level: new Float32Array(capacity),
    seed: new Float32Array(capacity),
    slant: new Float32Array(capacity),
    everSpawned: new Uint8Array(capacity),
    hist: new Float64Array(capacity * Math.max(1, histLen) * 2),
    histN: new Uint8Array(capacity),
    histHead: new Uint8Array(capacity),
    histAcc: new Float32Array(capacity),
  };
  for (let i = 0; i < capacity; i += 1) set.seed[i] = rng();
  return set;
}

export function resetParticles(set: ParticleSet): void {
  set.state.fill(STATE_IDLE);
  set.everSpawned.fill(0);
  set.histN.fill(0);
  set.histHead.fill(0);
}

export interface StepEnv {
  field: WindField;
  table: SpawnTable;
  /** World units per CSS px at the current zoom. */
  mercPerPx: number;
  rng: () => number;
  /** Multiplies every visual speed (1 = default). */
  speedScale?: number;
  /** Optional filter for spawn points (world units), e.g. "is on screen". */
  accept?: (x: number, y: number) => boolean;
}

interface SpawnPoint {
  slot: number;
  lon: number;
  lat: number;
}
const spawnPoint: SpawnPoint = { slot: -1, lon: 0, lat: 0 };

/** Draws a random point inside a weighted cell, retrying a few times for one `accept` allows. */
function chooseSpawn(env: StepEnv, grid: CellGrid): boolean {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slot = pickSlot(env.table, env.rng());
    if (slot < 0) return false;
    const lon = slotLon(grid, slot) + (env.rng() - 0.5) * grid.cellDeg;
    const lat = slotLat(grid, slot) + (env.rng() - 0.5) * grid.cellDeg;
    if (env.accept && !env.accept(lonToMercX(lon), latToMercY(lat))) continue;
    spawnPoint.slot = slot;
    spawnPoint.lon = lon;
    spawnPoint.lat = lat;
    return true;
  }
  return false;
}

/** Seconds between stored trail samples; trail length = histLen x this x speed. */
export const HISTORY_STEP_S = 1 / 15;
const WIND_LIFE_MIN = 1.2;
const WIND_LIFE_SPAN = 2.4;
/** Per-frame probability scale for waking an idle slot, so a refill does not arrive in one wave. */
const WAKE_RATE = 9;

const windScratch: WindSample = { u: 0, v: 0, speed: 0 };

function pushHistory(set: ParticleSet, i: number): void {
  const len = set.histLen;
  if (len === 0) return;
  const head = set.histHead[i];
  const base = (i * len + head) * 2;
  set.hist[base] = set.x[i];
  set.hist[base + 1] = set.y[i];
  set.histHead[i] = (head + 1) % len;
  if (set.histN[i] < len) set.histN[i] += 1;
}

/** Drops the oldest stored sample (the trail retracts towards the head). */
function dropOldest(set: ParticleSet, i: number): void {
  if (set.histN[i] > 0) set.histN[i] -= 1;
}

/**
 * Advances the first `active` wind particles by `dt` seconds. Alive ones follow the sampled wind
 * (towards-vector), leave their trail, and start dying when they exit the corridor, hit a cell
 * without wind, or reach the end of their life. Idle ones respawn inside a cell drawn from the
 * spawn table. Particles at index >= active are parked (state idle). Returns the alive count.
 */
export function stepWindParticles(set: ParticleSet, active: number, dt: number, env: StepEnv): number {
  const { field, table, mercPerPx, rng } = env;
  const speedScale = env.speedScale ?? 1;
  const grid = field.grid;
  const limit = Math.min(active, set.capacity);
  let alive = 0;
  const wake = Math.min(1, dt * WAKE_RATE);

  for (let i = 0; i < set.capacity; i += 1) {
    if (i >= limit) {
      set.state[i] = STATE_IDLE;
      continue;
    }
    const state = set.state[i];
    if (state === STATE_IDLE) {
      if (table.count === 0 || rng() > wake) continue;
      if (!chooseSpawn(env, grid)) continue;
      set.x[i] = lonToMercX(spawnPoint.lon);
      set.y[i] = latToMercY(spawnPoint.lat);
      set.age[i] = 0;
      set.life[i] = WIND_LIFE_MIN + WIND_LIFE_SPAN * rng();
      set.histN[i] = 0;
      set.histHead[i] = 0;
      set.histAcc[i] = 0;
      set.state[i] = STATE_ALIVE;
      set.everSpawned[i] = 1;
      continue;
    }

    if (state === STATE_DYING) {
      set.histAcc[i] += dt;
      while (set.histAcc[i] >= HISTORY_STEP_S * 0.5) {
        set.histAcc[i] -= HISTORY_STEP_S * 0.5;
        dropOldest(set, i);
      }
      if (set.histN[i] === 0) set.state[i] = STATE_IDLE;
      continue;
    }

    const lon = mercXToLon(set.x[i]);
    const lat = mercYToLat(set.y[i]);
    if (!sampleWind(field, lon, lat, windScratch)) {
      set.state[i] = STATE_DYING;
      set.histAcc[i] = 0;
      continue;
    }
    const magnitude = Math.hypot(windScratch.u, windScratch.v);
    set.level[i] = windScratch.speed;
    if (magnitude > 1e-4) {
      const pxPerSecond = visualSpeedPx(windScratch.speed) * (0.88 + 0.24 * set.seed[i]) * speedScale;
      const step = pxPerSecond * dt * mercPerPx;
      // v is northwards, world y grows southwards.
      set.x[i] += (windScratch.u / magnitude) * step;
      set.y[i] -= (windScratch.v / magnitude) * step;
    }
    set.age[i] += dt;
    set.histAcc[i] += dt;
    if (set.histAcc[i] >= HISTORY_STEP_S) {
      set.histAcc[i] -= HISTORY_STEP_S;
      pushHistory(set, i);
    }
    if (set.age[i] >= set.life[i]) {
      set.state[i] = STATE_DYING;
      set.histAcc[i] = 0;
    }
    alive += 1;
  }
  return alive;
}

export interface PrecipEnv extends StepEnv {
  kind: PrecipKind;
  /** Height in px particles fall from. */
  fallHeightPx: number;
}

const precipScratch: PrecipSample = { rain: 0, snow: 0 };
const slantWind: WindSample = { u: 0, v: 0, speed: 0 };

export const RAIN_FALL_PX_S = 330;
export const SNOW_FALL_PX_S = 38;
const PRECIP_WAKE_RATE_RAIN = 24;
const PRECIP_WAKE_RATE_SNOW = 5;
/** Snow drifts sideways at this share of the visual wind speed. */
const SNOW_DRIFT_SHARE = 0.3;

/**
 * Advances rain or snow. Each particle is a point on the ground plus a height that falls to zero;
 * it is anchored to the ground, so panning/zooming/pitching keeps the weather where the data is.
 * Landing (h <= 0) frees the slot, and `landed` (if given) is called with the landing spot.
 * Idle slots wake at random so a refill does not fall in lock-step; the very first appearance is
 * spread over the whole fall height. Returns the alive count.
 */
export function stepPrecipParticles(
  set: ParticleSet,
  active: number,
  dt: number,
  env: PrecipEnv,
  landed?: (x: number, y: number, intensity: number) => void,
): number {
  const { field, table, mercPerPx, rng, kind, fallHeightPx } = env;
  const speedScale = env.speedScale ?? 1;
  const grid = field.grid;
  const limit = Math.min(active, set.capacity);
  const wake = Math.min(1, dt * (kind === "rain" ? PRECIP_WAKE_RATE_RAIN : PRECIP_WAKE_RATE_SNOW));
  let alive = 0;

  for (let i = 0; i < set.capacity; i += 1) {
    if (i >= limit) {
      set.state[i] = STATE_IDLE;
      continue;
    }
    if (set.state[i] === STATE_IDLE) {
      if (table.count === 0 || rng() > wake) continue;
      if (!chooseSpawn(env, grid)) continue;
      const { slot, lon, lat } = spawnPoint;
      if (!samplePrecip(field, lon, lat, precipScratch)) continue;
      const here = kind === "rain" ? precipScratch.rain : precipScratch.snow;
      const cellValue = kind === "rain" ? field.rain[slot] : field.snow[slot];
      // Soft edge: a point near a drier neighbour keeps its streaks with probability here/cell.
      if (cellValue > 0 && rng() * cellValue > here) continue;
      const intensity = precipIntensity(kind, here);
      if (intensity <= 0) continue;
      set.x[i] = lonToMercX(lon);
      set.y[i] = latToMercY(lat);
      set.level[i] = intensity;
      set.age[i] = 0;
      set.h[i] = set.everSpawned[i] ? fallHeightPx * (0.92 + 0.12 * rng()) : fallHeightPx * rng();
      set.life[i] = 0;
      let slant = kind === "rain" ? 0.16 : 0;
      if (sampleWind(field, lon, lat, slantWind)) {
        slant = clamp(slant + slantWind.u / 70, -0.45, 0.6);
      }
      set.slant[i] = slant;
      set.state[i] = STATE_ALIVE;
      set.everSpawned[i] = 1;
      continue;
    }

    const lon = mercXToLon(set.x[i]);
    const lat = mercYToLat(set.y[i]);
    if (kind === "rain") {
      set.h[i] -= RAIN_FALL_PX_S * (0.88 + 0.24 * set.seed[i]) * speedScale * dt;
    } else {
      set.h[i] -= SNOW_FALL_PX_S * (0.7 + 0.6 * set.seed[i]) * speedScale * dt;
      set.age[i] += dt;
      if (sampleWind(field, lon, lat, slantWind)) {
        const magnitude = Math.hypot(slantWind.u, slantWind.v);
        if (magnitude > 1e-4) {
          const step = visualSpeedPx(slantWind.speed) * SNOW_DRIFT_SHARE * dt * mercPerPx * speedScale;
          set.x[i] += (slantWind.u / magnitude) * step;
          set.y[i] -= (slantWind.v / magnitude) * step;
        }
      } else if (slotAt(grid, lon, lat) < 0) {
        // Drifted out of the corridor: flakes only exist over cells.
        set.state[i] = STATE_IDLE;
        continue;
      }
    }
    if (set.h[i] <= 0) {
      if (landed) landed(set.x[i], set.y[i], set.level[i]);
      set.state[i] = STATE_IDLE;
      continue;
    }
    alive += 1;
  }
  return alive;
}

// ---------------------------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------------------------

export interface BudgetInput {
  /** CSS px of the map viewport. */
  width: number;
  height: number;
  devicePixelRatio: number;
  hardwareConcurrency: number;
  maxParticles?: number;
}

/** Upper bound of particles for a device. The engine further scales it by measured frame cost. */
export function particleBudget(input: BudgetInput): number {
  const max = input.maxParticles ?? 4000;
  let budget = max;
  const cores = Number.isFinite(input.hardwareConcurrency) && input.hardwareConcurrency > 0 ? input.hardwareConcurrency : 4;
  if (cores <= 2) budget *= 0.4;
  else if (cores <= 4) budget *= 0.65;
  else if (cores <= 6) budget *= 0.85;
  if (input.devicePixelRatio >= 2.5) budget *= 0.8;
  const area = input.width * input.height;
  if (area < 420_000) budget *= 0.6;
  else if (area < 900_000) budget *= 0.85;
  return Math.max(300, Math.round(budget));
}
