import { describe, expect, it } from "vitest";
import type { Checkpoint, PlanResponse, RouteOption } from "../api/types";
import plansFixture from "../mocks/plans.json";
import backendPlan from "../mocks/backend-plan.sample.json";
import { buildTimeline, frameHour, locate, nearestCheckpoint, sampleTimeline, timeAtMile } from "./tripTimeline";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-16T14:00:00Z");

function checkpoint(index: number, mile: number, etaMs: number): Checkpoint {
  return {
    index,
    mile,
    lat: 40,
    lon: -100 + mile / 100,
    eta: new Date(etaMs).toISOString(),
    weather: null,
    levels: null,
    level: null,
    level_label: "Unknown",
    reasons: [],
  };
}

/**
 * A 200 mi due-east route at 50 mph (4 h of driving) with a 30 min break after 2 h (mile 100):
 * checkpoints every 50 mi, ETAs including the break.
 */
function straightRoute(): RouteOption {
  const checkpoints = [
    checkpoint(0, 0, T0),
    checkpoint(1, 50, T0 + 1 * HOUR),
    checkpoint(2, 100, T0 + 2 * HOUR),
    checkpoint(3, 150, T0 + 3.5 * HOUR),
    checkpoint(4, 200, T0 + 4.5 * HOUR),
  ];
  return {
    id: "r1",
    label: "Route A",
    rank: 1,
    recommended: true,
    geometry: {
      type: "LineString",
      coordinates: [
        [-100, 40],
        [-99, 40],
        [-98, 40],
      ],
    },
    distance_mi: 200,
    drive_time_s: 4 * 3600,
    total_time_s: 4.5 * 3600,
    departure: new Date(T0).toISOString(),
    arrival: new Date(T0 + 4.5 * HOUR).toISOString(),
    summary: {
      miles_by_level: { low: 200, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 },
      avg_risk: 0,
      max_level: 0,
      weather_coverage: 1,
      checkpoint_count: 5,
      breaks: [
        {
          type: "break_30m",
          at_mile: 100,
          start: new Date(T0 + 2 * HOUR).toISOString(),
          end: new Date(T0 + 2.5 * HOUR).toISOString(),
        },
      ],
    },
    checkpoints,
  };
}

describe("trip timeline", () => {
  it("interpolates miles linearly between checkpoint ETAs while driving", () => {
    const line = buildTimeline(straightRoute());
    expect(sampleTimeline(line, T0).mile).toBeCloseTo(0, 6);
    expect(sampleTimeline(line, T0 + 0.5 * HOUR).mile).toBeCloseTo(25, 6);
    expect(sampleTimeline(line, T0 + 1 * HOUR).mile).toBeCloseTo(50, 6);
    // After the break the truck resumes at 50 mph: 3 h of clock = 2.5 h of driving.
    expect(sampleTimeline(line, T0 + 3 * HOUR).mile).toBeCloseTo(125, 6);
    expect(sampleTimeline(line, T0 + 4.5 * HOUR).mile).toBeCloseTo(200, 6);
  });

  it("stands still at the break and resumes after it", () => {
    const line = buildTimeline(straightRoute());
    expect(line.stops).toHaveLength(1);
    expect(line.stops[0]).toMatchObject({ kind: "break", label: "30-min break" });
    expect(line.stops[0].mile).toBeCloseTo(100, 6);

    const start = sampleTimeline(line, T0 + 2 * HOUR);
    const middle = sampleTimeline(line, T0 + 2.25 * HOUR);
    const last = sampleTimeline(line, T0 + 2.5 * HOUR - 1);
    for (const sample of [start, middle, last]) {
      expect(sample.stop?.label).toBe("30-min break");
      expect(sample.mile).toBeCloseTo(100, 6);
    }
    // Same spot on the map for the whole stop.
    expect(middle.lon).toBeCloseTo(start.lon, 9);
    expect(middle.lat).toBeCloseTo(start.lat, 9);

    const after = sampleTimeline(line, T0 + 2.5 * HOUR);
    expect(after.stop).toBeNull();
    expect(after.mile).toBeCloseTo(100, 6);
    expect(sampleTimeline(line, T0 + 2.5 * HOUR + 0.5 * HOUR).mile).toBeCloseTo(125, 6);
  });

  it("never moves backwards and clamps outside the trip", () => {
    const line = buildTimeline(straightRoute());
    let previous = -1;
    for (let t = T0 - HOUR; t <= T0 + 6 * HOUR; t += 6 * 60_000) {
      const { mile } = sampleTimeline(line, t);
      expect(mile).toBeGreaterThanOrEqual(previous);
      previous = mile;
    }
    expect(sampleTimeline(line, T0 - 5 * HOUR).mile).toBe(0);
    expect(sampleTimeline(line, T0 + 99 * HOUR).mile).toBe(200);
    expect(sampleTimeline(line, T0 + 99 * HOUR).progress).toBe(1);
  });

  it("puts the truck on the geometry and heads along it", () => {
    const line = buildTimeline(straightRoute());
    const half = sampleTimeline(line, T0 + 2 * HOUR); // mile 100, the middle of a 2-degree line
    expect(half.lon).toBeCloseTo(-99, 6);
    expect(half.lat).toBeCloseTo(40, 6);
    expect(half.bearing).toBeCloseTo(90, 3);
    expect(locate(line, 0)).toMatchObject({ lon: -100, lat: 40 });
    expect(locate(line, 200)).toMatchObject({ lon: -98, lat: 40 });
  });

  it("finds when the truck reaches a mile, counting breaks already taken", () => {
    const line = buildTimeline(straightRoute());
    expect(timeAtMile(line, 50)).toBeCloseTo(T0 + 1 * HOUR, 0);
    // At the break mile the truck arrives before the stop starts.
    expect(timeAtMile(line, 100)).toBeCloseTo(T0 + 2 * HOUR, 0);
    expect(timeAtMile(line, 150)).toBeCloseTo(T0 + 3.5 * HOUR, 0);
    expect(timeAtMile(line, 200)).toBeCloseTo(T0 + 4.5 * HOUR, 0);
  });

  it("works without any break", () => {
    const route = straightRoute();
    route.summary.breaks = [];
    route.checkpoints = [0, 50, 100, 150, 200].map((mile, index) => checkpoint(index, mile, T0 + (mile / 50) * HOUR));
    route.arrival = new Date(T0 + 4 * HOUR).toISOString();
    const line = buildTimeline(route);
    expect(line.stops).toEqual([]);
    expect(sampleTimeline(line, T0 + 3 * HOUR).mile).toBeCloseTo(150, 6);
    expect(sampleTimeline(line, T0 + 3 * HOUR).stop).toBeNull();
  });

  it("names a 10 h rest and keeps checkpoints reachable through it", () => {
    const route = straightRoute();
    route.summary.breaks = [
      {
        type: "off_duty_10h",
        at_mile: 100,
        start: new Date(T0 + 2 * HOUR).toISOString(),
        end: new Date(T0 + 12 * HOUR).toISOString(),
      },
    ];
    route.checkpoints = [
      checkpoint(0, 0, T0),
      checkpoint(1, 50, T0 + HOUR),
      checkpoint(2, 100, T0 + 2 * HOUR),
      checkpoint(3, 150, T0 + 13 * HOUR),
      checkpoint(4, 200, T0 + 14 * HOUR),
    ];
    route.arrival = new Date(T0 + 14 * HOUR).toISOString();
    const line = buildTimeline(route);
    const resting = sampleTimeline(line, T0 + 7 * HOUR);
    expect(resting.stop).toMatchObject({ kind: "rest", label: "10-h rest" });
    expect(resting.mile).toBeCloseTo(100, 6);
    expect(sampleTimeline(line, T0 + 13 * HOUR).mile).toBeCloseTo(150, 6);
  });

  it("agrees with the plan's own checkpoints and breaks on the demo fixture", () => {
    const plan = (plansFixture as unknown as { plans: Record<"25", PlanResponse> }).plans["25"];
    const route = plan.routes.find((item) => item.summary.breaks.length > 0)!;
    const line = buildTimeline(route);
    for (const item of route.checkpoints) {
      // A checkpoint ETA that falls on a break boundary is read on the arriving side.
      const sample = sampleTimeline(line, Date.parse(item.eta));
      expect(Math.abs(sample.mile - item.mile)).toBeLessThan(0.6);
    }
    route.summary.breaks.forEach((planned, index) => {
      expect(Math.abs(line.stops[index].mile - planned.at_mile)).toBeLessThan(1);
      expect(sampleTimeline(line, Date.parse(planned.start) + 1000).stop).not.toBeNull();
    });
  });

  it("agrees with the real backend payload", () => {
    const plan = backendPlan as unknown as PlanResponse;
    for (const route of plan.routes) {
      const line = buildTimeline(route);
      for (const item of route.checkpoints) {
        const sample = sampleTimeline(line, Date.parse(item.eta));
        expect(Math.abs(sample.mile - item.mile)).toBeLessThan(1);
      }
      route.summary.breaks.forEach((planned, index) => {
        expect(Math.abs(line.stops[index].mile - planned.at_mile)).toBeLessThan(2);
      });
    }
  });
});

describe("nearestCheckpoint and frameHour", () => {
  it("picks the closest checkpoint, ties going later", () => {
    const miles = [0, 25, 50, 75];
    expect(nearestCheckpoint(miles, 0)).toBe(0);
    expect(nearestCheckpoint(miles, 12)).toBe(0);
    expect(nearestCheckpoint(miles, 12.5)).toBe(1);
    expect(nearestCheckpoint(miles, 60)).toBe(2);
    expect(nearestCheckpoint(miles, 500)).toBe(3);
    expect(nearestCheckpoint([], 5)).toBe(-1);
  });

  it("maps trip time to the nearest forecast hour, clamped to 0 through 48", () => {
    expect(frameHour(T0, T0)).toBe(0);
    expect(frameHour(T0, T0 + 0.4 * HOUR)).toBe(0);
    expect(frameHour(T0, T0 + 0.6 * HOUR)).toBe(1);
    expect(frameHour(T0, T0 + 30 * HOUR)).toBe(30);
    expect(frameHour(T0, T0 + 80 * HOUR)).toBe(48);
    expect(frameHour(T0, T0 - 3 * HOUR)).toBe(0);
    expect(frameHour(Number.NaN, T0)).toBe(0);
  });
});
