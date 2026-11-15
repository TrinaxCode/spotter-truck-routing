import { describe, expect, it } from "vitest";
import { heatmapFillColor, heatmapFillOpacity } from "./heatmap";
import { segmentRoute } from "./routeSegments";
import type { RouteOption } from "../api/types";

describe("heatmap paint", () => {
  it("bakes the hour index into the expression", () => {
    const hour3 = heatmapFillColor("risk", 3);
    const hour0 = heatmapFillColor("risk", 0);
    expect(hour3).not.toEqual(hour0);
    expect(JSON.stringify(hour3)).toContain('["at",3,["get","risk"]]');
    expect(JSON.stringify(heatmapFillColor("wind", 12))).toContain('["at",12,["get","wind"]]');
    expect(heatmapFillOpacity("rain", 4, false)).toBe(0);
    expect(heatmapFillOpacity("snow", 1, true)).toEqual(["case", ["==", ["at", 1, ["get", "snow"]], null], 0, 0.4]);
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
