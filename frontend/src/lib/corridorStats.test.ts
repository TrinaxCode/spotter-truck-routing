import { describe, expect, it } from "vitest";
import type { HeatmapResponse } from "../api/types";
import { corridorStats } from "./corridorStats";

function heat(columns: Partial<Record<"risk" | "wind" | "rain" | "snow", (number | null)[]>>): HeatmapResponse {
  const cells = (columns.risk ?? columns.wind ?? columns.rain ?? columns.snow ?? []).length;
  const rows = (values?: (number | null)[]) =>
    Array.from({ length: cells }, (_, i) => [values ? values[i] : null]);
  return {
    plan_id: "p",
    start: "2026-11-16T14:00:00Z",
    hours: 1,
    cell_deg: 0.4,
    load_lbs: 35000,
    cells: Array.from({ length: cells }, () => ({ lat: 35, lon: -100 })),
    risk: rows(columns.risk),
    wind: rows(columns.wind),
    rain: rows(columns.rain),
    snow: rows(columns.snow),
  };
}

describe("corridorStats", () => {
  it("mixes risk levels over cells with data and names the worst", () => {
    const stats = corridorStats(heat({ risk: [0, 0, 1, 2, 3, null] }), "risk", 0);
    expect(stats.kind).toBe("risk");
    if (stats.kind !== "risk") return;
    expect(stats.known).toBe(5);
    expect(stats.shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(stats.worst).toBe(3);
    expect(stats.text).toBe("Worst Severe · 40% High or worse");
  });

  it("calls a Low/Moderate corridor clear and missing data unknown, never Low", () => {
    expect(corridorStats(heat({ risk: [0, 1, 1] }), "risk", 0).text).toBe("Corridor clear: worst Moderate");
    const empty = corridorStats(heat({ risk: [null, null] }), "risk", 0);
    expect(empty.text).toBe("No forecast for the corridor this hour");
    expect(empty.kind === "risk" && empty.worst).toBeNull();
  });

  it("reports peak and median wind, and dry corridors for precipitation", () => {
    expect(corridorStats(heat({ wind: [10, 30, 20, null] }), "wind", 0).text).toBe("Peak 30 mph · median 20 mph");
    expect(corridorStats(heat({ rain: [0, 0, 0.001] }), "rain", 0).text).toBe("Dry: no rain along the corridor");
    expect(corridorStats(heat({ snow: [0, 0.2, 0.05, 0.4] }), "snow", 0).text).toBe(
      "Peak 0.40 in/hr · 50% of the corridor ≥ 0.10 in/hr",
    );
  });
});
