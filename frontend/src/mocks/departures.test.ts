import { describe, expect, it } from "vitest";
import type { DepartureOptionsResponse, PlanResponse } from "../api/types";
import departureFixture from "./departure-options.mock.json";
import plansFixture from "./plans.json";
import { bestRoute, riskKey, suggest } from "./departures";

const plans = (plansFixture as unknown as { plans: Record<"10" | "25" | "50", PlanResponse> }).plans;
const fixture = departureFixture as unknown as Record<string, DepartureOptionsResponse>;

describe("demo departure options", () => {
  it("offset 0 reproduces the plan: same winner, same miles", () => {
    for (const plan of Object.values(plans)) {
      const data = fixture[plan.plan_id];
      expect(data.base_departure).toBe(plan.routes[0].departure);
      const now = data.options[0];
      expect(now.offset_h).toBe(0);
      expect(now.best_route_id).toBe(plan.recommended_route_id);
      for (const route of plan.routes) {
        const scored = now.routes.find((item) => item.route_id === route.id)!;
        expect(scored.miles_by_level).toEqual(route.summary.miles_by_level);
        expect(scored.avg_risk).toBe(route.summary.avg_risk);
        expect(scored.weather_coverage).toBe(route.summary.weather_coverage);
      }
    }
  });

  it("has 25 hourly options in the contract window and a suggestion that really is better", () => {
    for (const data of Object.values(fixture)) {
      expect(data.options.slice(0, 25).map((item) => item.offset_h)).toEqual([...Array(25).keys()]);
      expect(data.suggestion).not.toBeNull();
      const pick = data.options.find((item) => item.offset_h === data.suggestion!.offset_h)!;
      expect(pick.departure).toBe(data.suggestion!.departure);
      const base = riskKey(bestRoute(data.options[0].routes)!);
      const better = riskKey(bestRoute(pick.routes)!);
      expect(better.join()).not.toBe(base.join());
      expect(data.suggestion!.headline).toMatch(/^Leave \d+ h later on Route [ABC] to (avoid|cut) /);
    }
  });
});

describe("suggest", () => {
  const labels = (id: string) => `Route ${id}`;
  const score = (id: string, miles: Record<string, number>, coverage = 1) => ({
    route_id: id,
    miles_by_level: { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0, ...miles },
    avg_risk: 0.5,
    max_level: 1 as const,
    weather_coverage: coverage,
    total_time_s: 1,
    arrival: "x",
  });
  const option = (offset: number, ...routes: ReturnType<typeof score>[]) => ({
    offset_h: offset,
    departure: `d${offset}`,
    best_route_id: routes[0].route_id,
    routes,
  });

  it("is null when leaving at the planned time is already the best", () => {
    expect(suggest([option(0, score("a", { high: 5 })), option(1, score("a", { high: 5 })), option(2, score("a", { high: 9 }))], labels)).toBeNull();
  });

  it("takes the earliest of equally good later departures and names the biggest improvement", () => {
    const result = suggest(
      [
        option(0, score("a", { severe: 40, high: 10 })),
        option(1, score("a", { severe: 20, high: 10 })),
        option(2, score("a", { severe: 0, high: 10 })),
        option(3, score("a", { severe: 0, high: 10 })),
      ],
      labels,
    );
    expect(result).toMatchObject({ offset_h: 2, route_id: "a", improvement: { severe_mi: 40, high_mi: 0, no_travel_mi: 0 } });
    expect(result?.headline).toBe("Leave 2 h later on Route a to avoid 40 mi of Severe weather.");
  });

  it("ranks complete forecast ahead of fewer risky miles, so missing data never looks safe", () => {
    const result = suggest(
      [option(0, score("a", { high: 30 })), option(1, score("a", { high: 0, unknown: 200 }, 0.75))],
      labels,
    );
    expect(result).toBeNull();
  });
});
