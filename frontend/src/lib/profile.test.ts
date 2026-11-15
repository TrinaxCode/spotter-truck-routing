import { describe, expect, it } from "vitest";
import type { PlanResponse, RouteOption } from "../api/types";
import plansFixture from "../mocks/plans.json";
import {
  PAD_X,
  PROFILE_HEIGHT,
  buildProfile,
  formatReadout,
  precipDomain,
  profileSummary,
  readoutAtMile,
  windDomain,
} from "./profile";
import { buildTimeline } from "./tripTimeline";

const plan = (plansFixture as unknown as { plans: Record<"25", PlanResponse> }).plans["25"];
const route = plan.routes.find((item) => item.summary.breaks.length === 2 && item.summary.max_level != null) as RouteOption;

describe("profile scales", () => {
  it("keeps the 55 mph No Travel line on the wind axis and grows for extreme gusts", () => {
    expect(windDomain(0)).toBe(60);
    expect(windDomain(48)).toBe(60);
    expect(windDomain(60)).toBe(60);
    expect(windDomain(61)).toBe(70);
    expect(windDomain(83)).toBe(90);
  });

  it("scales precipitation in steps and never below 0.5 in/hr", () => {
    expect(precipDomain(0)).toBe(0.5);
    expect(precipDomain(0.14)).toBe(0.5);
    expect(precipDomain(0.51)).toBe(1);
    expect(precipDomain(1)).toBe(1);
    expect(precipDomain(1.2)).toBe(2);
    expect(precipDomain(3.6)).toBe(4);
  });

  it("maps miles to pixels and back", () => {
    const model = buildProfile(route, buildTimeline(route), 340);
    expect(model.x(0)).toBe(PAD_X);
    expect(model.x(route.distance_mi)).toBe(340 - PAD_X);
    expect(model.x(route.distance_mi / 2)).toBeCloseTo(170, 6);
    for (const mile of [0, 123.4, route.distance_mi]) {
      expect(model.mileAt(model.x(mile))).toBeCloseTo(mile, 6);
    }
    // Pointers outside the plot clamp to the ends instead of leaving the route.
    expect(model.mileAt(-50)).toBe(0);
    expect(model.mileAt(9999)).toBe(model.distanceMi);
    expect(model.height).toBe(PROFILE_HEIGHT);
  });

  it("draws wind with 55 mph above 25 mph and inside the plot", () => {
    const model = buildProfile(route, buildTimeline(route), 340);
    const [t25, t35, t45, t55] = model.thresholds;
    expect([t25.mph, t35.mph, t45.mph, t55.mph]).toEqual([25, 35, 45, 55]);
    expect(t25.y).toBeGreaterThan(t35.y);
    expect(t45.y).toBeGreaterThan(t55.y);
    expect(model.yWind(0)).toBe(model.plot.bottom);
    expect(model.yWind(model.windMax)).toBe(model.plot.top);
    for (const point of model.windPoints) {
      expect(point.y).toBeGreaterThanOrEqual(model.plot.top);
      expect(point.y).toBeLessThanOrEqual(model.plot.bottom);
    }
  });

  it("covers the whole route with the risk band, one cell per checkpoint", () => {
    const model = buildProfile(route, buildTimeline(route), 340);
    expect(model.bands).toHaveLength(route.checkpoints.length);
    const width = model.bands.reduce((sum, band) => sum + band.width, 0);
    expect(width).toBeCloseTo(340 - 2 * PAD_X, 6);
    expect(model.bands[0].x).toBeCloseTo(PAD_X, 6);
    expect(model.bands.map((band) => band.level)).toEqual(route.checkpoints.map((item) => item.level));
  });

  it("places HOS stops and ETA ticks, with fewer ticks when the chart is narrow", () => {
    const timeline = buildTimeline(route);
    const wide = buildProfile(route, timeline, 340);
    expect(wide.breaks.map((item) => item.label)).toEqual(["30-min break", "10-h rest"]);
    expect(wide.breaks[0].x).toBeLessThan(wide.breaks[1].x);
    expect(wide.ticks.map((tick) => tick.anchor)).toEqual(["start", "middle", "middle", "end"]);
    expect(wide.ticks[0].top).toBe("Mile 0");
    expect(wide.ticks[3].top).toBe(`Mile ${Math.round(route.distance_mi)}`);
    expect(buildProfile(route, timeline, 280).ticks).toHaveLength(3);
  });

  it("stacks rain under snow and leaves forecast gaps out of the wind line", () => {
    const copy = structuredClone(route);
    copy.checkpoints[3].weather = null;
    copy.checkpoints[3].level = null;
    copy.checkpoints[5].weather!.rain_in_hr = 0.25;
    copy.checkpoints[5].weather!.snow_in_hr = 0.25;
    const model = buildProfile(copy, buildTimeline(copy), 340);
    expect(model.windLines).toHaveLength(2);
    expect(model.bars.find((bar) => bar.index === 3)).toBeUndefined();
    const bar = model.bars.find((item) => item.index === 5)!;
    expect(bar.rainHeight).toBeGreaterThan(0);
    expect(bar.snowHeight).toBeCloseTo(bar.rainHeight, 6);
    expect(bar.rainHeight + bar.snowHeight).toBeLessThanOrEqual(model.precip.bottom - model.precip.top);
  });
});

describe("profile text", () => {
  it("reads out the owning checkpoint at a mile", () => {
    const timeline = buildTimeline(route);
    const target = route.checkpoints[10];
    const readout = readoutAtMile(route, timeline, target.mile + 3);
    expect(readout.checkpoint).toBe(10);
    expect(readout.windMph).toBe(target.weather?.wind_mph);
    expect(readout.level).toBe(target.level);
    const text = formatReadout({ mile: 412, tMs: Date.parse("2026-11-17T09:10:00Z"), checkpoint: 3, windMph: 31, level: 2 });
    expect(text).toMatch(/^Mile 412 · \w{3} \d{1,2}:10 [AP]M · Wind 31 mph · High$/);
    expect(formatReadout({ mile: 5, tMs: 0, checkpoint: -1, windMph: null, level: null })).toMatch(
      /Wind unavailable · Unknown$/,
    );
  });

  it("summarises the profile for screen readers", () => {
    const text = profileSummary(route, buildTimeline(route));
    expect(text).toContain(`Weather profile for ${route.label}`);
    expect(text).toMatch(/Peak sustained wind \d+(\.\d)? mph near mile \d+\./);
    expect(text).toContain("30-min break near mile");
    expect(text).toContain("10-h rest near mile");
    expect(text).toMatch(/Risk by distance: Low/);
  });
});
