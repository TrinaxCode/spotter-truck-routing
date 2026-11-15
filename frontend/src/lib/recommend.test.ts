import { describe, expect, it } from "vitest";
import type { MilesByLevel, PlanResponse, RouteOption } from "../api/types";
import { describeRecommendation } from "./recommend";

function route(
  id: string,
  rank: number,
  miles: Partial<MilesByLevel>,
  options: { coverage?: number; totalTimeS?: number } = {},
): RouteOption {
  return {
    id,
    label: `Route ${id}`,
    rank,
    recommended: rank === 1,
    geometry: { type: "LineString", coordinates: [] },
    distance_mi: 100,
    drive_time_s: options.totalTimeS ?? 3600,
    total_time_s: options.totalTimeS ?? 3600,
    departure: "2026-11-16T14:00:00Z",
    arrival: "2026-11-16T15:00:00Z",
    summary: {
      miles_by_level: { low: 100, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0, ...miles },
      avg_risk: 0,
      max_level: 0,
      weather_coverage: options.coverage ?? 1,
      checkpoint_count: 5,
      breaks: [],
    },
    checkpoints: [],
  };
}

function plan(...routes: RouteOption[]): PlanResponse {
  return {
    plan_id: "p",
    generated_at: "2026-11-16T13:00:00Z",
    request: {} as PlanResponse["request"],
    recommended_route_id: routes[0].id,
    recommendation: { route_id: routes[0].id, explanation: [] },
    warnings: [],
    routes,
  };
}

describe("describeRecommendation", () => {
  it("returns null without routes", () => {
    expect(describeRecommendation({ ...plan(route("A", 1, {})), routes: [] })).toBeNull();
  });

  it("calls a fully covered, hazard-free winner the safest", () => {
    const result = describeRecommendation(plan(route("A", 1, {}), route("B", 2, { severe: 12 }, { totalTimeS: 7200 })));
    expect(result?.caution).toBe(false);
    expect(result?.headline).toBe("Route A is safest: no Severe or High miles, 1 hr 00 min faster than Route B.");
  });

  it("keeps High miles in the reason for a clean winner", () => {
    const result = describeRecommendation(plan(route("A", 1, { high: 4.2 }), route("B", 2, { high: 30 })));
    expect(result?.headline).toContain("is safest: no Severe miles and only 4.2 mi of High risk");
    expect(result?.caution).toBe(false);
  });

  it("never says safest when the winner crosses No Travel miles", () => {
    const result = describeRecommendation(
      plan(route("A", 1, { no_travel: 10, low: 90 }), route("B", 2, { no_travel: 40, low: 60 })),
    );
    expect(result?.headline).toBe(
      "Route A has the least risk, but crosses 10 mi of No Travel conditions (about as fast as Route B).",
    );
    expect(result?.headline).not.toMatch(/safest/i);
    expect(result?.caution).toBe(true);
  });

  it("never says safest when the winner crosses Severe miles", () => {
    const result = describeRecommendation(plan(route("A", 1, { severe: 3.2, low: 96.8 }), route("B", 2, { severe: 9 })));
    expect(result?.headline).toContain("has the least risk, but crosses 3.2 mi of Severe conditions");
    expect(result?.headline).not.toMatch(/safest/i);
    expect(result?.caution).toBe(true);
  });

  it("names both hazards when the winner has No Travel and Severe miles", () => {
    const result = describeRecommendation(plan(route("A", 1, { no_travel: 5, severe: 8 })));
    expect(result?.headline).toBe("Route A has the least risk, but crosses 5 mi of No Travel and 8 mi of Severe conditions.");
  });

  it("is not triggered by a hazard on a route that did not win", () => {
    const result = describeRecommendation(plan(route("A", 1, {}), route("B", 2, { no_travel: 20 })));
    expect(result?.caution).toBe(false);
    expect(result?.headline).toMatch(/is safest/);
  });

  it("is provisional when the winner has incomplete weather coverage", () => {
    const result = describeRecommendation(
      plan(route("B", 1, { unknown: 6, low: 94 }, { coverage: 0.94 }), route("A", 2, { high: 20 })),
    );
    expect(result?.headline).toBe(
      "Route B is the best available pick, but forecast data is incomplete for Route B (94% covered): no Severe or High miles where the forecast is known, about as fast as Route A.",
    );
    expect(result?.headline).not.toMatch(/safest|full forecast/i);
    expect(result?.caution).toBe(true);
  });

  it("is provisional when only a losing route lacks coverage", () => {
    const result = describeRecommendation(plan(route("A", 1, {}), route("B", 2, { unknown: 50 }, { coverage: 0.5 })));
    expect(result?.headline).toContain("Route A is the best available pick, but forecast data is incomplete for Route B (50% covered)");
    expect(result?.headline).not.toMatch(/safest/i);
    expect(result?.caution).toBe(true);
  });

  it("never rounds a coverage gap up to 100%", () => {
    const result = describeRecommendation(plan(route("A", 1, { unknown: 0.2 }, { coverage: 0.9996 })));
    expect(result?.headline).toContain("Route A (99% covered)");
  });

  it("combines a hazard with incomplete coverage without claiming safety", () => {
    const result = describeRecommendation(
      plan(route("A", 1, { no_travel: 10, unknown: 5 }, { coverage: 0.95 }), route("B", 2, { no_travel: 30 })),
    );
    expect(result?.headline).toBe(
      "Route A is the best available pick, but it crosses 10 mi of No Travel conditions (about as fast as Route B). Forecast data is incomplete for Route A (95% covered).",
    );
    expect(result?.caution).toBe(true);
  });
});
