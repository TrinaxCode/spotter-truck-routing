import { describe, expect, it, vi } from "vitest";
import heatmapSample from "../mocks/backend-heatmap.sample.json";
import planSample from "../mocks/backend-plan.sample.json";
import { corridorFeatures } from "../lib/heatmap";
import { segmentRoute } from "../lib/routeSegments";
import { etaHourIndex } from "../lib/time";
import { createApiClient } from "./client";
import { ApiError, describeApiError, flattenFieldErrors, isRetryable } from "./errors";
import type {
  Checkpoint,
  CheckpointWeather,
  DutyBreak,
  HeatmapResponse,
  PlanResponse,
  RouteOption,
  RouteSummary,
} from "./types";

/**
 * The samples are real backend output (backend/tests/test_frontend_contract.py regenerates and
 * pins them), so these tests fail when the backend and src/api/types.ts drift apart.
 */
const plan = planSample as unknown as PlanResponse;
const heat = heatmapSample as unknown as HeatmapResponse;

function keysOf<T>(value: object, expected: readonly (keyof T & string)[]) {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

const isIsoZ = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(value);

describe("backend plan payload", () => {
  it("has exactly the fields declared in types.ts", () => {
    keysOf<PlanResponse>(plan, [
      "plan_id", "generated_at", "request", "recommended_route_id", "recommendation", "warnings", "routes",
    ]);
    expect(plan.routes).toHaveLength(3);
    for (const route of plan.routes) {
      keysOf<RouteOption>(route, [
        "id", "label", "rank", "recommended", "geometry", "distance_mi", "drive_time_s", "total_time_s",
        "departure", "arrival", "summary", "checkpoints",
      ]);
      keysOf<RouteSummary>(route.summary, [
        "miles_by_level", "avg_risk", "max_level", "weather_coverage", "checkpoint_count", "breaks",
      ]);
      expect(Object.keys(route.summary.miles_by_level).sort()).toEqual(
        ["high", "low", "moderate", "no_travel", "severe", "unknown"],
      );
      for (const pause of route.summary.breaks) {
        keysOf<DutyBreak>(pause, ["type", "at_mile", "start", "end"]);
      }
      for (const checkpoint of route.checkpoints) {
        keysOf<Checkpoint>(checkpoint, [
          "index", "mile", "lat", "lon", "eta", "weather", "levels", "level", "level_label", "reasons",
        ]);
        if (checkpoint.weather) {
          keysOf<CheckpointWeather>(checkpoint.weather, [
            "wind_mph", "gust_mph", "rain_in_hr", "snow_in_hr", "temp_f", "weather_code", "forecast_time",
          ]);
        }
      }
    }
  });

  it("uses whole-second UTC timestamps the browser parses everywhere", () => {
    expect(isIsoZ(plan.generated_at) && isIsoZ(plan.request.departure)).toBe(true);
    for (const route of plan.routes) {
      expect(isIsoZ(route.departure) && isIsoZ(route.arrival)).toBe(true);
      for (const checkpoint of route.checkpoints) expect(isIsoZ(checkpoint.eta)).toBe(true);
    }
  });

  it("keeps the documented null contract for unknown weather", () => {
    const unknown = plan.routes.flatMap((route) => route.checkpoints).filter((c) => c.level === null);
    expect(unknown.length).toBeGreaterThan(0);
    for (const checkpoint of unknown) {
      expect(checkpoint.weather).toBeNull();
      expect(checkpoint.levels).toBeNull();
      expect(checkpoint.level_label).toBe("Unknown");
      expect(checkpoint.reasons.length).toBeGreaterThan(0);
    }
    const partial = plan.routes.find((route) => route.summary.weather_coverage < 1);
    expect(partial?.summary.miles_by_level.unknown).toBeGreaterThan(0);
    expect(plan.warnings.join(" ")).toMatch(/coverage/i);
  });

  it("has one recommended route that matches rank 1 and the recommendation block", () => {
    const best = plan.routes.filter((route) => route.recommended);
    expect(best).toHaveLength(1);
    expect(best[0].rank).toBe(1);
    expect(plan.recommended_route_id).toBe(best[0].id);
    expect(plan.recommendation.route_id).toBe(best[0].id);
    expect(plan.recommendation.explanation.length).toBeGreaterThan(0);
    expect(plan.routes.map((route) => route.rank).sort()).toEqual([1, 2, 3]);
  });

  it("splits every route into coloured segments, including unknown ones", () => {
    for (const route of plan.routes) {
      const segments = segmentRoute(route);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.some((segment) => segment.level === null)).toBe(route.summary.weather_coverage < 1);
    }
  });

  it("maps each checkpoint to a heatmap frame inside the 49 hours", () => {
    for (const route of plan.routes) {
      for (const checkpoint of route.checkpoints) {
        const frame = etaHourIndex(heat.start, checkpoint.eta);
        expect(frame).toBeGreaterThanOrEqual(0);
        expect(frame).toBeLessThan(49);
      }
    }
  });
});

describe("backend heatmap payload", () => {
  it("is columnar with 49 frames per cell and nulls where weather is missing", () => {
    keysOf<HeatmapResponse>(heat, ["plan_id", "start", "hours", "cell_deg", "load_lbs", "cells", "risk", "wind", "rain", "snow"]);
    expect(heat.plan_id).toBe(plan.plan_id);
    expect(heat.hours).toBe(49);
    for (const variable of ["risk", "wind", "rain", "snow"] as const) {
      expect(heat[variable]).toHaveLength(heat.cells.length);
      for (const row of heat[variable]) expect(row).toHaveLength(49);
    }
    expect(heat.risk.flat()).toContain(null);
    expect(heat.risk.flat().some((value) => value !== null && value >= 3)).toBe(true);
    const features = corridorFeatures(heat);
    expect(features.features).toHaveLength(heat.cells.length);
    expect(features.features[0].properties.risk).toHaveLength(49);
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const request = { ...plan.request, interval_mi: 25 as const };

describe("error envelope handling", () => {
  it("keeps DRF nested/list field errors and flattens them for the form", async () => {
    const fields = {
      origin: { lat: ["Ensure this value is less than or equal to 90."] },
      departure: ["Departure must be between one hour ago and 14 days ahead."],
      load_lbs: ["An integer is required."],
    };
    const client = createApiClient({
      useMocks: false,
      fetchFn: vi.fn(async () =>
        jsonResponse(400, { error: { code: "validation_error", message: "Invalid request.", fields } }),
      ),
    });
    const error = await client.planRoutes(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).fields).toEqual(fields);
    expect(flattenFieldErrors((error as ApiError).fields)).toEqual({
      origin: "Ensure this value is less than or equal to 90.",
      departure: "Departure must be between one hour ago and 14 days ahead.",
      load_lbs: "An integer is required.",
    });
    expect(describeApiError(error, "x")).toContain("Departure must be between");
    expect(isRetryable(error)).toBe(false);
  });

  it("explains a 503 not_configured in plain language and does not offer a retry", async () => {
    const client = createApiClient({
      useMocks: false,
      fetchFn: vi.fn(async () =>
        jsonResponse(503, { error: { code: "not_configured", message: "Routing is not configured. Set TOMTOM_API_KEY on the server." } }),
      ),
    });
    const error = await client.planRoutes(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 503, code: "not_configured" });
    expect(describeApiError(error, "x")).toMatch(/not available/i);
    expect(describeApiError(error, "x")).not.toMatch(/TOMTOM/);
    expect(isRetryable(error)).toBe(false);
  });

  it("survives a non-envelope body (HTML crash page, bare detail) and a 502 stays retryable", async () => {
    for (const body of [new Response("<h1>Server Error</h1>", { status: 500 }), jsonResponse(500, { detail: "boom" }), jsonResponse(500, null)]) {
      const client = createApiClient({ useMocks: false, fetchFn: vi.fn(async () => body) });
      const error = await client.health().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ status: 500, code: "http_error", message: "Request failed (500)." });
    }
    const client = createApiClient({
      useMocks: false,
      fetchFn: vi.fn(async () => jsonResponse(502, { error: { code: "upstream_error", message: "Try again." } })),
    });
    const error = await client.planRoutes(request).catch((caught: unknown) => caught);
    expect(isRetryable(error)).toBe(true);
  });

  it("turns an unreadable success body into an ApiError", async () => {
    const client = createApiClient({ useMocks: false, fetchFn: vi.fn(async () => new Response("<html>", { status: 200 })) });
    await expect(client.health()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
