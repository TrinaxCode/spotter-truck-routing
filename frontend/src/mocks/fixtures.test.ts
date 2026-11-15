import { describe, expect, it } from "vitest";
import type { HeatmapResponse, PlanResponse } from "../api/types";
import { assess } from "./assess";
import { elapsedWithBreaks } from "./hos";
import heatmapFixture from "./heatmap.json";
import plansFixture from "./plans.json";

interface Bundle {
  plans: Record<"10" | "25" | "50", PlanResponse>;
}

const plans = (plansFixture as unknown as Bundle).plans;
const heatmap = heatmapFixture as unknown as HeatmapResponse;

describe("fixtures", () => {
  it("covers severe, no travel, and a missing checkpoint on the 25 mile plan", () => {
    const plan = plans["25"];
    const levels = plan.routes.flatMap((route) => route.checkpoints.map((checkpoint) => checkpoint.level));
    expect(levels).toContain(3);
    expect(levels).toContain(4);
    expect(levels).toContain(null);
    expect(plan.routes).toHaveLength(3);
    expect(heatmap.hours).toBe(49);
    expect(heatmap.risk).toHaveLength(heatmap.cells.length);
    for (const row of heatmap.risk) expect(row).toHaveLength(49);
  });

  it("matches the risk rules and HOS elapsed time", () => {
    for (const route of plans["25"].routes) {
      expect(route.total_time_s).toBe(elapsedWithBreaks(route.drive_time_s, true));
      const miles = route.summary.miles_by_level;
      const sum = miles.low + miles.moderate + miles.high + miles.severe + miles.no_travel + miles.unknown;
      expect(Math.abs(sum - route.distance_mi)).toBeLessThan(0.2);
      for (const checkpoint of route.checkpoints) {
        if (!checkpoint.weather) {
          expect(checkpoint.level).toBeNull();
          expect(checkpoint.levels).toBeNull();
          expect(checkpoint.level_label).toBe("Unknown");
          expect(checkpoint.reasons.join(" ")).toMatch(/unavailable/i);
          continue;
        }
        const scored = assess(
          checkpoint.weather.wind_mph,
          checkpoint.weather.rain_in_hr,
          checkpoint.weather.snow_in_hr,
          35000,
        );
        expect(checkpoint.level).toBe(scored.level);
        expect(checkpoint.reasons).toEqual(scored.reasons);
      }
    }
  });
});
