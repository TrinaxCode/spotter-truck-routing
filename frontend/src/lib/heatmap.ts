import type { HeatmapResponse, HeatVariable } from "../api/types";
import { RISK_COLORS, UNKNOWN_COLOR } from "./riskColor";

export type PaintExpr = unknown[];

const WIND_STOPS: PaintExpr = [0, "#d5ebe3", 25, "#e6c14a", 35, "#e07a14", 45, "#d3202f", 55, "#4c1d78"];
const RAIN_STOPS: PaintExpr = [0, "#d5ebe3", 0.1, "#7eb6d6", 0.25, "#2f6fad", 0.5, "#1d3f73", 1, "#4c1d78"];
const SNOW_STOPS: PaintExpr = [0, "#d5ebe3", 0.5, "#9fd0ea", 1, "#4f86c6", 2, "#d3202f", 3, "#4c1d78"];

/** Paint expression for one hour. The hour is a literal index into property arrays. */
export function heatmapFillColor(variable: HeatVariable, hour: number): PaintExpr {
  const value: PaintExpr = ["at", hour, ["get", variable]];
  if (variable === "risk") {
    return [
      "case",
      ["==", value, null],
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
  const stops = variable === "wind" ? WIND_STOPS : variable === "rain" ? RAIN_STOPS : SNOW_STOPS;
  return ["case", ["==", value, null], "rgba(0,0,0,0)", ["interpolate", ["linear"], value, ...stops]];
}

export function heatmapFillOpacity(
  variable: HeatVariable,
  hour: number,
  visible: boolean,
): number | PaintExpr {
  if (!visible) return 0;
  const value: PaintExpr = ["at", hour, ["get", variable]];
  return ["case", ["==", value, null], 0, 0.4];
}

export interface CorridorFeatureCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    id: number;
    properties: {
      risk: (number | null)[];
      wind: (number | null)[];
      rain: (number | null)[];
      snow: (number | null)[];
    };
    geometry: { type: "Polygon"; coordinates: [number, number][][] };
  }[];
}

/** One square polygon per cell. Hourly values stay on the feature; the slider never rebuilds this. */
export function corridorFeatures(data: HeatmapResponse): CorridorFeatureCollection {
  const half = data.cell_deg / 2;
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
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [cell.lon - half, cell.lat - half],
            [cell.lon + half, cell.lat - half],
            [cell.lon + half, cell.lat + half],
            [cell.lon - half, cell.lat + half],
            [cell.lon - half, cell.lat - half],
          ],
        ],
      },
    })),
  };
}
