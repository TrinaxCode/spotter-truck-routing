import { describe, expect, it } from "vitest";
import type { DepartureOption, DepartureOptionsResponse, DepartureRouteScore } from "../api/types";
import { MIN_BAR, barHeight, describeBar, riskyMiles, stayLabel, stripBars, stripSummary } from "./departure";

function score(
  id: string,
  miles: Partial<DepartureRouteScore["miles_by_level"]>,
  extra: Partial<DepartureRouteScore> = {},
): DepartureRouteScore {
  return {
    route_id: id,
    miles_by_level: { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0, ...miles },
    avg_risk: 0.3,
    max_level: 1,
    weather_coverage: 1,
    total_time_s: 80_000,
    arrival: "2026-11-17T12:00:00Z",
    ...extra,
  };
}

function option(offset: number, best: string, routes: DepartureRouteScore[]): DepartureOption {
  const at = Date.parse("2026-11-16T22:00:00Z") + offset * 3_600_000;
  return { offset_h: offset, departure: new Date(at).toISOString(), best_route_id: best, routes };
}

const labels = (id: string) => (id === "r1" ? "Route A" : id === "r2" ? "Route B" : id);

function response(options: DepartureOption[]): DepartureOptionsResponse {
  return { plan_id: "p", base_departure: "2026-11-16T22:00:00Z", options, suggestion: null };
}

describe("departure strip scaling", () => {
  it("shows a baseline for none and scales the rest against the riskiest departure", () => {
    expect(barHeight(0, 100)).toBe(MIN_BAR);
    expect(barHeight(0, 0)).toBe(MIN_BAR);
    expect(barHeight(100, 100)).toBe(1);
    expect(barHeight(50, 100)).toBeCloseTo(0.6, 6);
    // One risky mile is still clearly taller than none.
    expect(barHeight(1, 400)).toBeGreaterThan(MIN_BAR * 2);
    expect(barHeight(500, 100)).toBe(1);
  });

  it("counts High, Severe and No Travel miles as risky", () => {
    expect(riskyMiles(score("r1", { low: 500, moderate: 90, high: 10, severe: 5, no_travel: 2.5 }))).toBe(17.5);
  });

  it("builds one bar per hour with colour from the worst level and height from risky miles", () => {
    const bars = stripBars(
      response([
        option(0, "r1", [score("r1", { low: 700, high: 100, severe: 20 }, { max_level: 3 }), score("r2", { low: 800 })]),
        option(1, "r2", [score("r1", { low: 800 }), score("r2", { low: 790, high: 10 }, { max_level: 2 })]),
        option(2, "r1", [score("r1", { low: 800 }, { max_level: 0 })]),
      ]),
      labels,
    );
    expect(bars.map((bar) => bar.offset)).toEqual([0, 1, 2]);
    expect(bars[0]).toMatchObject({ level: 3, riskyMi: 120, severeMi: 20, highMi: 100, routeLabel: "Route A", height: 1 });
    expect(bars[1].routeLabel).toBe("Route B");
    expect(bars[1].height).toBeGreaterThan(MIN_BAR);
    expect(bars[1].height).toBeLessThan(bars[0].height);
    expect(bars[2].height).toBe(MIN_BAR);
    expect(new Set(bars.map((bar) => bar.color)).size).toBe(3);
  });

  it("writes the tooltip and accessible name per bar", () => {
    const bars = stripBars(
      response([
        option(0, "r1", [score("r1", { low: 800 })]),
        option(3, "r2", [score("r2", { low: 790, severe: 0, no_travel: 0, high: 12.5 })]),
      ]),
      labels,
    );
    expect(bars[0].text).toMatch(/^Planned departure · \d{1,2}:00 [AP]M · Route A · 0 mi Severe or worse · 0 mi High$/);
    expect(bars[1].text).toMatch(/^\+3 h · \d{1,2}:00 [AP]M · Route B · 0 mi Severe or worse · 12.5 mi High$/);
    expect(describeBar({ ...bars[1], partial: true })).toMatch(/forecast incomplete$/);
  });

  it("never reads missing forecast as safe, and labels departures on another day", () => {
    const bars = stripBars(
      response([
        option(0, "r1", [score("r1", { low: 700, unknown: 100 }, { weather_coverage: 0.875 })]),
        option(12, "r1", [score("r1", { low: 800 }, { max_level: null })]),
      ]),
      labels,
    );
    expect(bars[0].partial).toBe(true);
    expect(bars[0].text).toContain("forecast incomplete");
    expect(bars[1].level).toBeNull();
    expect(bars[1].color).toBe("#7c8794");
    expect(bars[1].timeLabel).toMatch(/^\w{3} \d{1,2}:00 [AP]M$/);
  });

  it("summarises the strip and phrases the no-better-time message", () => {
    const bars = stripBars(
      response([
        option(0, "r1", [score("r1", { low: 700, high: 100 }, { max_level: 2 })]),
        option(24, "r1", [score("r1", { low: 800 }, { max_level: 0 })]),
      ]),
      labels,
    );
    expect(stripSummary(bars)).toBe(
      "Departures over the next 24 hours. 1 of 2 stay at Moderate or better. Worst level on any best route: High.",
    );
    expect(stripSummary([])).toBe("No departure options.");
    expect(stayLabel("2026-11-15T15:00:00Z", "2026-11-15T14:30:00Z")).toBe(
      "Leaving now is already the lowest-risk option in the next 24 h.",
    );
    expect(stayLabel("2026-11-17T15:00:00Z", "2026-11-15T14:30:00Z")).toBe(
      "Leaving at your planned time is already the lowest-risk option in the next 24 h.",
    );
  });
});
