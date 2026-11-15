import type { RiskLevel } from "../api/types";

const RISK_LABELS = ["Low", "Moderate", "High", "Severe", "No Travel"] as const;

/**
 * One palette for both themes; keep it aligned with the --low/moderate/high/severe/halt CSS tokens.
 * Each colour is at least 3:1 against the dark route casing (#0a0f1a) and the dark basemap, so
 * route lines drawn with that casing clear 3:1 on the light basemap too. No Travel is a deep
 * magenta and is also marked with a dashed overlay on the map and a hatch in bars and legends.
 */
export const RISK_COLORS: Record<RiskLevel, string> = {
  0: "#2fcf84",
  1: "#f6c928",
  2: "#ff8a1f",
  3: "#ff3d57",
  4: "#c026d3",
};

export const UNKNOWN_COLOR = "#7c8794";
export const NEUTRAL_ROUTE_COLOR = { light: "#64748b", dark: "#94a3b8" } as const;

export function riskColor(level: number | null | undefined): string {
  if (level == null || !(level in RISK_COLORS)) return UNKNOWN_COLOR;
  return RISK_COLORS[level as RiskLevel];
}

export function riskLabel(level: number | null | undefined): string {
  if (level == null || level < 0 || level > 4) return "Unknown";
  return RISK_LABELS[level as RiskLevel];
}

const MILE_KEYS = ["low", "moderate", "high", "severe", "no_travel", "unknown"] as const;

export function milesByLevelLabel(miles: Record<(typeof MILE_KEYS)[number], number>): string {
  const parts = MILE_KEYS.filter((key) => miles[key] > 0).map((key) => {
    const label = key === "no_travel" ? "No Travel" : key === "unknown" ? "Unknown" : key[0].toUpperCase() + key.slice(1);
    return `${label} ${formatMileChunk(miles[key])}`;
  });
  return parts.length > 0 ? parts.join(", ") : "No scored miles";
}

function formatMileChunk(miles: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(miles)} mi`;
}
