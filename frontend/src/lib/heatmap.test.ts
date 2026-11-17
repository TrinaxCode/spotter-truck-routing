import { describe, expect, it } from "vitest";
import { corridorFeatures, corridorOutlineFeatures, heatmapCoverage, heatmapFillColor, heatmapFillOpacity, radarRadius, RAMPS } from "./heatmap";
import { createExpression, latest, type StylePropertySpecification } from "@maplibre/maplibre-gl-style-spec";
import { RISK_COLORS } from "./riskColor";
import { segmentRoute } from "./routeSegments";
import { etaHourIndex } from "./time";
import type { HeatmapResponse, RouteOption } from "../api/types";

describe("heatmap paint", () => {
  function evaluate(expression: unknown, properties = {}, zoom = 0, color = false) {
    const parsed = createExpression(expression, "paint", color ? latest.paint_circle["circle-color"] as StylePropertySpecification : undefined);
    if (parsed.result === "error") throw new Error(JSON.stringify(parsed.value));
    return parsed.value.evaluateWithoutErrorHandling({ zoom }, { type: "Point", properties });
  }

  it("keeps all missing frames transparent in every variable, including an absent row", () => {
    for (const variable of ["risk", "wind", "rain", "snow"] as const) {
      for (const row of [Array(49).fill(null), [], [12, null, 30]]) {
        const properties = { [variable]: row };
        for (const hour of row[0] === 12 ? [1, 24, 48] : [0, 24, 48]) {
          expect(evaluate(heatmapFillOpacity(variable, hour, true), properties)).toBe(0);
          expect(evaluate(heatmapFillColor(variable, hour), properties, 0, true).a).toBe(0);
        }
      }
    }
  });

  it("reads known values from mixed nullable rows without rejecting the entire array", () => {
    for (const variable of ["risk", "wind", "rain", "snow"] as const) {
      for (const hour of [0, 2]) {
        const mixed = { [variable]: [2, null, 1] };
        const known = { [variable]: [2, 0, 1] };
        expect(evaluate(heatmapFillColor(variable, hour), mixed, 0, true)).toEqual(evaluate(heatmapFillColor(variable, hour), known, 0, true));
        expect(evaluate(heatmapFillOpacity(variable, hour, true), mixed)).toEqual(evaluate(heatmapFillOpacity(variable, hour, true), known));
      }
    }
  });

  it("preserves each categorical risk colour and keeps Low barely visible at every hour", () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      for (let hour = 0; hour < 49; hour++) {
        const properties = { risk: Array(49).fill(level) };
        const actual = evaluate(heatmapFillColor("risk", hour), properties, 0, true);
        expect(actual).toEqual(evaluate(RISK_COLORS[level], {}, 0, true));
        const opacity = evaluate(heatmapFillOpacity("risk", hour, true), properties);
        expect(opacity).toBeGreaterThan(0);
        if (level === 0) expect(opacity).toBeLessThan(0.08);
        expect(evaluate(heatmapFillOpacity("risk", hour, true, 0.5), properties)).toBeCloseTo(opacity / 2, 3);
      }
    }
  });

  it("retains continuous ramp stops, clear dry cells, and theme/fade gain", () => {
    for (const variable of ["wind", "rain", "snow"] as const) {
      for (const [value, color] of RAMPS[variable].stops) {
        const properties = { [variable]: Array(49).fill(value) };
        expect(evaluate(heatmapFillColor(variable, 48), properties, 0, true)).toEqual(evaluate(color, {}, 0, true));
        const opacity = evaluate(heatmapFillOpacity(variable, 48, true), properties);
        expect(evaluate(heatmapFillOpacity(variable, 48, true, 0.85), properties)).toBeCloseTo(opacity * 0.85, 3);
        if (value === 0 && variable !== "wind") expect(opacity).toBe(0);
      }
    }
  });

  it("scales the radar footprint with geographic cell size and doubles at every zoom", () => {
    const small = radarRadius(0.2);
    const large = radarRadius(0.4);
    for (const zoom of [4, 4.5, 7, 10, 11]) {
      const radius = evaluate(small, { latitudeScale: 1.3 }, zoom);
      expect(evaluate(small, { latitudeScale: 1.3 }, zoom + 1)).toBeCloseTo(radius * 2);
      expect(evaluate(large, { latitudeScale: 1.3 }, zoom)).toBeCloseTo(radius * 2);
    }
  });

  it("uses cell centres and retains the original hourly arrays on a stable feature", () => {
    const row = Array.from({ length: 49 }, (_, hour) => hour === 48 ? null : 2);
    const data: HeatmapResponse = {
      plan_id: "radar", start: "2026-11-16T14:00:00Z", hours: 49, cell_deg: 0.4,
      load_lbs: 35000, cells: [{ lon: -100, lat: 40 }],
      risk: [row], wind: [row], rain: [row], snow: [row],
    };
    const feature = corridorFeatures(data).features[0];
    expect(feature.id).toBe(0);
    expect(feature.geometry).toEqual({ type: "Point", coordinates: [-100, 40] });
    expect(feature.properties.risk).toBe(row);
    expect(feature.properties.latitudeScale).toBeCloseTo(1 / Math.cos(40 * Math.PI / 180));
    const outline = corridorOutlineFeatures(data).features[0];
    expect(outline.id).toBe(feature.id);
    expect(outline.properties).toEqual(feature.properties);
    expect(outline.geometry.coordinates).toEqual([[[-100.2, 39.8], [-99.8, 39.8], [-99.8, 40.2], [-100.2, 40.2], [-100.2, 39.8]]]);
  });

  it("bakes the hour index into the expression", () => {
    const hour3 = heatmapFillColor("risk", 3);
    const hour0 = heatmapFillColor("risk", 0);
    expect(hour3).not.toEqual(hour0);
    expect(JSON.stringify(hour3)).toContain('["at",3,["get","risk"]]');
    expect(JSON.stringify(heatmapFillColor("wind", 12))).toContain('["at",12,["get","wind"]]');
    expect(heatmapFillOpacity("rain", 4, false)).toBe(0);
    // Opacity follows the value too, and still indexes the hour literally.
    expect(JSON.stringify(heatmapFillOpacity("snow", 1, true))).toContain('["at",1,["get","snow"]]');
    expect(heatmapFillOpacity("snow", 1, true, 0)).toBe(0);
  });
});

describe("route segments", () => {
  it("splits a line at owned-mile boundaries", () => {
    const route = {
      id: "r1",
      label: "Route A",
      rank: 1,
      recommended: true,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0, 1],
        ],
      },
      distance_mi: 100,
      drive_time_s: 1,
      total_time_s: 1,
      departure: "2026-11-16T14:00:00Z",
      arrival: "2026-11-16T15:00:00Z",
      summary: {
        miles_by_level: { low: 100, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 },
        avg_risk: 0,
        max_level: 0,
        weather_coverage: 1,
        checkpoint_count: 3,
        breaks: [],
      },
      checkpoints: [
        { index: 0, mile: 0, lat: 0, lon: 0, eta: "2026-11-16T14:00:00Z", weather: null, levels: { wind: 0, rain: 0, snow: 0 }, level: 0, level_label: "Low", reasons: [] },
        { index: 1, mile: 50, lat: 0.5, lon: 0, eta: "2026-11-16T14:30:00Z", weather: null, levels: { wind: 4, rain: 0, snow: 0 }, level: 4, level_label: "No Travel", reasons: [] },
        { index: 2, mile: 100, lat: 1, lon: 0, eta: "2026-11-16T15:00:00Z", weather: null, levels: { wind: 0, rain: 0, snow: 0 }, level: 0, level_label: "Low", reasons: [] },
      ],
    } satisfies RouteOption;
    const segments = segmentRoute(route);
    expect(segments.map((segment) => segment.level)).toEqual([0, 4, 0]);
    expect(segments.every((segment) => segment.coordinates.length >= 2)).toBe(true);
  });
});

describe("checkpoint to frame alignment", () => {
  const start = "2026-11-16T14:00:00Z";
  it("picks the hour the backend read the checkpoint weather from", () => {
    expect(etaHourIndex(start, "2026-11-16T14:00:00Z")).toBe(0);
    expect(etaHourIndex(start, "2026-11-16T14:29:59Z")).toBe(0);
    // Nearest-hour wind (ties later) and the closing precipitation hour both resolve to 15:00.
    expect(etaHourIndex(start, "2026-11-16T14:30:00Z")).toBe(1);
    expect(etaHourIndex(start, "2026-11-16T14:59:00Z")).toBe(1);
    expect(etaHourIndex(start, "2026-11-18T14:00:00Z")).toBe(48);
    expect(etaHourIndex(start, "2026-11-18T14:30:00Z")).toBe(-1);
    expect(etaHourIndex(start, "2026-11-16T13:00:00Z")).toBe(-1);
  });
});

describe("variable-aware checkpoint frames", () => {
  const start = "2026-11-16T14:00:00Z";
  const eta = "2026-11-16T14:20:00Z";

  it("reads wind from the nearest hour for a 14:20 ETA", () => {
    expect(etaHourIndex(start, eta, "wind")).toBe(0);
    expect(etaHourIndex(start, eta)).toBe(0);
  });

  it("reads rain and snow from the hour that closes the ETA", () => {
    expect(etaHourIndex(start, eta, "rain")).toBe(1);
    expect(etaHourIndex(start, eta, "snow")).toBe(1);
  });

  it("lights a checkpoint under Risk in the frame whose hour window contains the ETA", () => {
    // Frame 1 (15:00) covers 14:00-15:00, which contains 14:20; frame 0 covers 13:00-14:00.
    expect(etaHourIndex(start, eta, "risk")).toBe(1);
  });

  it("keeps hour boundaries in the frame that ends there and clamps to the 49 frames", () => {
    expect(etaHourIndex(start, "2026-11-16T14:00:00Z", "rain")).toBe(0);
    expect(etaHourIndex(start, "2026-11-16T15:00:00Z", "rain")).toBe(1);
    expect(etaHourIndex(start, "2026-11-16T14:30:00Z", "wind")).toBe(1);
    expect(etaHourIndex(start, "2026-11-18T14:00:00Z", "rain")).toBe(48);
    expect(etaHourIndex(start, "2026-11-18T14:20:00Z", "rain")).toBe(-1);
    expect(etaHourIndex(start, "2026-11-18T14:20:00Z", "wind")).toBe(48);
    expect(etaHourIndex(start, "2026-11-16T13:00:00Z", "rain")).toBe(-1);
    expect(etaHourIndex(start, "not a time", "rain")).toBe(-1);
  });
});

describe("heatmap coverage", () => {
  function heat(overrides: Partial<Pick<HeatmapResponse, "risk" | "wind" | "rain" | "snow">>): HeatmapResponse {
    const empty = [[null, null], [null, null]];
    return {
      plan_id: "p",
      start: "2026-11-16T14:00:00Z",
      hours: 2,
      cell_deg: 0.5,
      load_lbs: 30000,
      cells: [
        { lat: 1, lon: 1 },
        { lat: 2, lon: 2 },
      ],
      risk: empty,
      wind: empty,
      rain: empty,
      snow: empty,
      ...overrides,
    };
  }

  it("is none when no cell has a value in any hour", () => {
    expect(heatmapCoverage(heat({}))).toEqual({ risk: "none", wind: "none", rain: "none", snow: "none" });
  });

  it("is none when there are no cells", () => {
    expect(heatmapCoverage({ ...heat({}), cells: [], risk: [], wind: [], rain: [], snow: [] }).risk).toBe("none");
  });

  it("is partial with some nulls and full with none", () => {
    const result = heatmapCoverage(
      heat({
        risk: [[0, null], [1, 2]],
        wind: [[10, 12], [8, 9]],
      }),
    );
    expect(result).toEqual({ risk: "partial", wind: "full", rain: "none", snow: "none" });
  });
});
