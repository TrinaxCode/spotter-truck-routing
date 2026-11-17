import type { HeatmapResponse, HeatVariable } from "../api/types";
import { formatInchesPerHour, formatSpeedMph } from "./format";
import { riskLabel } from "./riskColor";

/** Share of the corridor's cells (with data) at each risk level for one forecast hour. */
export interface RiskMix {
  kind: "risk";
  /** Fractions 0..1 for levels 0..4; they sum to 1 when any cell has data. */
  shares: [number, number, number, number, number];
  worst: number | null;
  /** Cells with a forecast this hour. */
  known: number;
  text: string;
}

export interface ValueSpread {
  kind: "value";
  peak: number | null;
  median: number | null;
  /** Share of cells (with data) above the variable's "notable" threshold. */
  notableShare: number;
  known: number;
  text: string;
}

export type CorridorStats = RiskMix | ValueSpread;

/** A value worth calling out: Moderate wind, measurable rain, any snow. */
const NOTABLE: Record<Exclude<HeatVariable, "risk">, number> = { wind: 25, rain: 0.1, snow: 0.1 };

const percent = (share: number) => `${Math.round(share * 100)}%`;

function column(heat: HeatmapResponse, variable: HeatVariable, hour: number): number[] {
  const rows = heat[variable];
  const values: number[] = [];
  for (const row of rows) {
    const value = row[hour];
    if (value != null && Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** What the whole corridor looks like at one forecast hour, for the timeline card. */
export function corridorStats(heat: HeatmapResponse, variable: HeatVariable, hour: number): CorridorStats {
  const values = column(heat, variable, hour);
  if (variable === "risk") {
    const counts = [0, 0, 0, 0, 0];
    for (const value of values) counts[Math.min(4, Math.max(0, Math.round(value)))] += 1;
    const known = values.length;
    const shares = counts.map((count) => (known ? count / known : 0)) as RiskMix["shares"];
    const worst = known ? counts.reduce((top, count, level) => (count > 0 ? level : top), 0) : null;
    const elevated = shares[2] + shares[3] + shares[4];
    const text =
      worst == null
        ? "No forecast for the corridor this hour"
        : worst <= 1
          ? `Corridor clear: worst ${riskLabel(worst)}`
          : `Worst ${riskLabel(worst)} · ${percent(elevated)} High or worse`;
    return { kind: "risk", shares, worst, known, text };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const known = sorted.length;
  const peak = known ? sorted[known - 1] : null;
  const median = known ? sorted[Math.floor((known - 1) / 2)] : null;
  const notableShare = known ? sorted.filter((value) => value >= NOTABLE[variable]).length / known : 0;
  const format = variable === "wind" ? formatSpeedMph : formatInchesPerHour;
  let text: string;
  if (peak == null || median == null) text = "No forecast for the corridor this hour";
  else if (variable === "wind") text = `Peak ${format(peak)} · median ${format(median)}`;
  else if (peak < 0.005) text = `Dry: no ${variable} along the corridor`;
  else text = `Peak ${format(peak)} · ${percent(notableShare)} of the corridor ≥ ${format(NOTABLE[variable])}`;
  return { kind: "value", peak, median, notableShare, known, text };
}
