import { describe, expect, it, vi } from "vitest";
import departuresSample from "../mocks/backend-departures.sample.json";
import { stripBars, stripSummary } from "../lib/departure";
import { createApiClient } from "./client";
import type { DepartureOption, DepartureOptionsResponse, DepartureRouteScore, DepartureSuggestion } from "./types";

/**
 * The sample is backend output for GET /api/departure-options. It must keep matching the shapes in
 * types.ts and keep feeding the strip without any adapter.
 */
const data = departuresSample as unknown as DepartureOptionsResponse;

const isIsoZ = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(value);
const keysOf = <T,>(value: object, expected: readonly (keyof T & string)[]) =>
  expect(Object.keys(value).sort()).toEqual([...expected].sort());

describe("backend departure options payload", () => {
  it("has exactly the fields declared in types.ts", () => {
    keysOf<DepartureOptionsResponse>(data, ["plan_id", "base_departure", "options", "suggestion"]);
    for (const option of data.options) {
      keysOf<DepartureOption>(option, ["offset_h", "departure", "best_route_id", "routes"]);
      for (const route of option.routes) {
        keysOf<DepartureRouteScore>(route, [
          "route_id", "miles_by_level", "avg_risk", "max_level", "weather_coverage", "total_time_s", "arrival",
        ]);
        expect(Object.keys(route.miles_by_level).sort()).toEqual(
          ["high", "low", "moderate", "no_travel", "severe", "unknown"],
        );
      }
    }
    if (data.suggestion) {
      keysOf<DepartureSuggestion>(data.suggestion, ["offset_h", "departure", "route_id", "headline", "improvement"]);
      expect(Object.keys(data.suggestion.improvement).sort()).toEqual(["high_mi", "no_travel_mi", "severe_mi"]);
    }
  });

  it("covers the next 24 hours hourly with whole-second UTC timestamps", () => {
    expect(data.options.map((option) => option.offset_h)).toEqual([...Array(25).keys()]);
    expect(isIsoZ(data.base_departure)).toBe(true);
    data.options.forEach((option, index) => {
      expect(isIsoZ(option.departure) && option.routes.every((route) => isIsoZ(route.arrival))).toBe(true);
      expect(Date.parse(option.departure)).toBe(Date.parse(data.base_departure) + index * 3_600_000);
      expect(option.routes.map((route) => route.route_id)).toContain(option.best_route_id);
    });
    expect(data.options[0].departure).toBe(data.base_departure);
  });

  it("points the suggestion at a real option and route", () => {
    expect(data.suggestion).not.toBeNull();
    const suggestion = data.suggestion!;
    const option = data.options.find((item) => item.offset_h === suggestion.offset_h)!;
    expect(option.departure).toBe(suggestion.departure);
    expect(option.best_route_id).toBe(suggestion.route_id);
    expect(suggestion.headline).toMatch(/^Leave \d+ h later on Route [A-Z] to /);
  });

  it("feeds the strip as is: 25 bars, the planned one first, hatched only when data is missing", () => {
    const bars = stripBars(data, (id) => `Route ${id.toUpperCase()}`);
    expect(bars).toHaveLength(25);
    expect(bars[0].text).toMatch(/^Planned departure · /);
    expect(bars.every((bar) => bar.height > 0 && bar.height <= 1)).toBe(true);
    expect(stripSummary(bars)).toMatch(/^Departures over the next 24 hours\./);
  });

  it("is fetched with the plan id the plan response carries", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createApiClient({ useMocks: false, fetchFn });
    await expect(client.fetchDepartureOptions(data.plan_id)).resolves.toEqual(data);
    const url = String((fetchFn.mock.calls as unknown as [string][])[0][0]);
    expect(url).toContain(`/api/departure-options?plan_id=${data.plan_id}`);
  });
});
