import type { HeatmapResponse, HeatVariable } from "../api/types";
import { RISK_COLORS, UNKNOWN_COLOR } from "./riskColor";

export type PaintExpr = unknown[];
export type ContinuousVariable = Exclude<HeatVariable, "risk">;

export interface RampSpec {
  unit: string;
  /** Value at the right end of the legend bar. */
  max: number;
  /** [value, colour] pairs. Values above the last stop keep its colour. */
  stops: [number, string][];
  /** [value, opacity]. Calm cells fade out so storms stand out of the basemap. */
  opacity: [number, number][];
  /** Labelled thresholds on the legend bar. */
  ticks: { value: number; label: string }[];
}

/** Wind follows the risk thresholds (25/35/45/55 mph); rain and snow use their own ramps. */
export const RAMPS: Record<ContinuousVariable, RampSpec> = {
  wind: {
    unit: "mph",
    max: 60,
    stops: [
      [0, RISK_COLORS[0]],
      [18, RISK_COLORS[0]],
      [25, RISK_COLORS[1]],
      [35, RISK_COLORS[2]],
      [45, RISK_COLORS[3]],
      [55, RISK_COLORS[4]],
    ],
    opacity: [
      [0, 0.1],
      [18, 0.2],
      [25, 0.42],
      [35, 0.52],
      [45, 0.6],
      [55, 0.68],
    ],
    ticks: [
      { value: 0, label: "0" },
      { value: 25, label: "25" },
      { value: 35, label: "35" },
      { value: 45, label: "45" },
      { value: 55, label: "55+" },
    ],
  },
  rain: {
    unit: "in/hr",
    max: 1.2,
    stops: [
      [0, "#5fd4e6"],
      [0.1, "#37a8e0"],
      [0.25, "#3b6fe6"],
      [0.5, "#5a4bd6"],
      [1, RISK_COLORS[4]],
    ],
    opacity: [
      [0, 0],
      [0.01, 0.2],
      [0.1, 0.4],
      [0.25, 0.52],
      [0.5, 0.6],
      [1, 0.68],
    ],
    ticks: [
      { value: 0, label: "0" },
      { value: 0.1, label: "0.1" },
      { value: 0.25, label: "0.25" },
      { value: 0.5, label: "0.5" },
      { value: 1, label: "1+" },
    ],
  },
  snow: {
    unit: "in/hr",
    max: 3.6,
    stops: [
      [0, "#d6ebff"],
      [0.5, "#9cc7ff"],
      [1, "#7d9bff"],
      [2, "#a06bf0"],
      [3, RISK_COLORS[4]],
    ],
    opacity: [
      [0, 0],
      [0.02, 0.25],
      [0.5, 0.42],
      [1, 0.52],
      [2, 0.6],
      [3, 0.68],
    ],
    ticks: [
      { value: 0, label: "0" },
      { value: 0.5, label: "0.5" },
      { value: 1, label: "1" },
      { value: 2, label: "2" },
      { value: 3, label: "3+" },
    ],
  },
};

/** CSS linear-gradient for a ramp legend bar, positioned by value. */
export function rampGradient(variable: ContinuousVariable): string {
  const spec = RAMPS[variable];
  const stops = spec.stops.map(([value, color]) => `${color} ${((value / spec.max) * 100).toFixed(1)}%`);
  const last = spec.stops[spec.stops.length - 1];
  stops.push(`${last[1]} 100%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function interpolate(value: PaintExpr, pairs: readonly (readonly [number, unknown])[]): PaintExpr {
  return ["interpolate", ["linear"], value, ...pairs.flat()];
}

/** A short/missing row is unknown, including the last forecast frame. */
function hourlyValue(variable: HeatVariable, hour: number): PaintExpr {
  // Assert the scalar, not the array: MapLibre otherwise infers array<number> from
  // match/interpolate and rejects an entire row when any of its 49 values is null.
  return ["case", ["<", hour, ["length", ["get", variable]]], ["number", ["coalesce", ["at", hour, ["get", variable]], -1], -1], -1];
}

/** Paint expression for one hour. The hour is a literal index into property arrays. */
export function heatmapFillColor(variable: HeatVariable, hour: number): PaintExpr {
  const value = hourlyValue(variable, hour);
  if (variable === "risk") {
    return [
      "case",
      ["==", value, -1],
      "rgba(0,0,0,0)",
      [
        "match",
        value,
        0,
        RISK_COLORS[0],
        1,
        RISK_COLORS[1],
        2,
        RISK_COLORS[2],
        3,
        RISK_COLORS[3],
        4,
        RISK_COLORS[4],
        UNKNOWN_COLOR,
      ],
    ];
  }
  return ["case", ["==", value, -1], "rgba(0,0,0,0)", interpolate(value, RAMPS[variable].stops)];
}

// Low is a whisper so the corridor reads as "where it gets worse", not a green carpet.
const RISK_OPACITY: [number, number][] = [
  [0, 0.07],
  [1, 0.42],
  [2, 0.52],
  [3, 0.6],
  [4, 0.68],
];

/**
 * Fill opacity for one hour. `gain` (0..1) scales every cell; the controller eases it for the
 * fade-in and the light-basemap tuning without touching the source.
 */
export function heatmapFillOpacity(
  variable: HeatVariable,
  hour: number,
  visible: boolean,
  gain = 1,
): number | PaintExpr {
  if (!visible || gain <= 0) return 0;
  const value = hourlyValue(variable, hour);
  const scaled = (pairs: readonly (readonly [number, number])[]) =>
    pairs.map(([key, opacity]) => [key, Number((opacity * gain).toFixed(3))] as const);
  if (variable === "risk") {
    return [
      "case",
      ["==", value, -1],
      0,
      ["match", value, ...scaled(RISK_OPACITY).flat(), Number((0.3 * gain).toFixed(3))],
    ];
  }
  return ["case", ["==", value, -1], 0, interpolate(value, scaled(RAMPS[variable].opacity))];
}

interface CorridorProperties {
  risk: (number | null)[];
  wind: (number | null)[];
  rain: (number | null)[];
  snow: (number | null)[];
  latitudeScale: number;
}

export type CorridorFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, CorridorProperties>;

/**
 * Soft discs overlap across cell diagonals; their tails end about one cell away.
 * 512 px is MapLibre's world size at z0. Exponential base 2 keeps the footprint fixed
 * on the ground at fractional zooms too. Latitude accounts for Mercator stretching.
 * Unlike a density heatmap, hue represents the cell value, not the count of neighbours.
 */
export function radarRadius(cellDeg: number): PaintExpr {
  const radius = 512 * cellDeg / 360 * 0.95;
  const atZoom = (zoom: number): PaintExpr => ["*", radius * 2 ** zoom, ["get", "latitudeScale"]];
  return ["interpolate", ["exponential", 2], ["zoom"], 0, atZoom(0), 24, atZoom(24)];
}

/** One radar sample per cell; all 49 hours are uploaded once, never on slider input. */
export function corridorFeatures(data: HeatmapResponse): CorridorFeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.cells.map((cell, index) => ({
      type: "Feature",
      id: index,
      properties: {
        risk: data.risk[index] ?? [],
        wind: data.wind[index] ?? [],
        rain: data.rain[index] ?? [],
        snow: data.snow[index] ?? [],
        latitudeScale: 1 / Math.cos(Math.min(85, Math.abs(cell.lat)) * Math.PI / 180),
      },
      geometry: { type: "Point", coordinates: [cell.lon, cell.lat] },
    })),
  };
}

/** Barely visible at close range: exact sample extents, never an interpolated risk claim. */
export function corridorOutlineFeatures(data: HeatmapResponse): GeoJSON.FeatureCollection<GeoJSON.Polygon, CorridorProperties> {
  const half = data.cell_deg / 2;
  return {
    type: "FeatureCollection",
    features: corridorFeatures(data).features.map((feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      return {
        ...feature,
        geometry: { type: "Polygon", coordinates: [[
          [lon - half, lat - half], [lon + half, lat - half],
          [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half],
        ]] },
      };
    }),
  };
}

export type HeatCoverage = "full" | "partial" | "none";

function variableCoverage(rows: (number | null)[][]): HeatCoverage {
  let known = 0;
  let missing = 0;
  for (const row of rows) {
    for (const value of row) {
      if (value == null) missing += 1;
      else known += 1;
    }
  }
  if (known === 0) return "none";
  return missing > 0 ? "partial" : "full";
}

/**
 * How much of each variable's grid carries data. A 200 whose values are all null (cells exist,
 * no forecast) is "none" and must be handled as an error, not as a ready, empty map; some nulls
 * (hours or cells past the forecast) are "partial".
 */
export function heatmapCoverage(data: HeatmapResponse): Record<HeatVariable, HeatCoverage> {
  return {
    risk: variableCoverage(data.risk),
    wind: variableCoverage(data.wind),
    rain: variableCoverage(data.rain),
    snow: variableCoverage(data.snow),
  };
}
