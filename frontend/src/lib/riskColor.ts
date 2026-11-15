import type { RiskLevel } from "../api/types";

const RISK_LABELS = ["Low", "Moderate", "High", "Severe", "No Travel"] as const;

/** Keep these hex values aligned with the --color-low/moderate/high/severe/halt tokens. */
export const RISK_COLORS: Record<RiskLevel, string> = {
  0: "#127a45",
  1: "#a37a08",
  2: "#c4550a",
  3: "#c41628",
  4: "#4c1d78",
};

export const UNKNOWN_COLOR = "#5c6b64";
export const NEUTRAL_ROUTE_COLOR = "#6d7f76";

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
