import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint, RouteOption } from "../api/types";
import { buildTimeline } from "../lib/tripTimeline";
import { useTripPlayback } from "./useTripPlayback";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-16T14:00:00Z");

function route(): RouteOption {
  const cp = (index: number, mile: number, eta: number): Checkpoint => ({
    index,
    mile,
    lat: 40,
    lon: -100 + mile / 100,
    eta: new Date(eta).toISOString(),
    weather: null,
    levels: null,
    level: null,
    level_label: "Unknown",
    reasons: [],
  });
  return {
    id: "r1",
    label: "Route A",
    rank: 1,
    recommended: true,
    geometry: { type: "LineString", coordinates: [[-100, 40], [-98, 40]] },
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
        { type: "break_30m", at_mile: 100, start: new Date(T0 + 2 * HOUR).toISOString(), end: new Date(T0 + 2.5 * HOUR).toISOString() },
      ],
    },
    checkpoints: [cp(0, 0, T0), cp(1, 50, T0 + HOUR), cp(2, 100, T0 + 2 * HOUR), cp(3, 150, T0 + 3.5 * HOUR), cp(4, 200, T0 + 4.5 * HOUR)],
  };
}

/** A hand-cranked requestAnimationFrame: nothing runs until `advance`. */
let queue = new Map<number, FrameRequestCallback>();
let nextId = 1;
let clock = 0;

function advance(ms: number, frame = 16) {
  for (let spent = 0; spent < ms; spent += frame) {
    clock += frame;
    const due = [...queue.entries()];
    queue = new Map();
    for (const [, callback] of due) callback(clock);
  }
}

beforeEach(() => {
  queue = new Map();
  nextId = 1;
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(reduceMotion = false) {
  const timeline = buildTimeline(route());
  const onTruck = vi.fn();
  const onHour = vi.fn();
  const onPlaying = vi.fn();
  const hook = renderHook(() =>
    useTripPlayback({ timeline, heatStartIso: new Date(T0).toISOString(), reduceMotion, onTruck, onHour, onPlaying }),
  );
  return { ...hook, onTruck, onHour, onPlaying };
}

describe("useTripPlayback", () => {
  it("moves the truck at five trip minutes per second at 1x and follows the forecast hour", () => {
    const { result, onTruck, onHour, onPlaying } = setup();
    act(() => result.current.setSpeed(1));
    act(() => result.current.play());
    expect(result.current.status).toBe("playing");
    expect(onPlaying).toHaveBeenLastCalledWith(true);
    expect(onHour).toHaveBeenCalledWith(0);

    act(() => advance(12_000));
    // 12 s of wall clock at 1x is one trip hour: 50 mi at 50 mph.
    const last = onTruck.mock.calls.at(-1)![0];
    expect(last.mile).toBeGreaterThan(45);
    expect(last.mile).toBeLessThan(55);
    expect(onHour).toHaveBeenLastCalledWith(1);
    const miles = onTruck.mock.calls.map(([sample]) => sample.mile);
    expect([...miles].sort((a, b) => a - b)).toEqual(miles);
  });

  it("starts at 3x and runs thirty times faster at 30x", () => {
    const { result, onTruck } = setup();
    expect(result.current.speed).toBe(3);
    act(() => result.current.setSpeed(30));
    act(() => result.current.play());
    act(() => advance(400));
    // 0.4 s at 150 trip minutes per second is one trip hour.
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeGreaterThan(45);
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeLessThan(55);
  });

  it("parks at a break for a fixed 1.5 s on screen, whatever the speed, then finishes", () => {
    const { result, onTruck, onHour } = setup();
    act(() => result.current.setSpeed(30));
    act(() => result.current.play());
    // At 30x (150 trip min/s) the break at trip hour 2 starts after 0.8 s.
    act(() => advance(900));
    let sample = onTruck.mock.calls.at(-1)![0];
    expect(sample.stop?.label).toBe("30-min break");
    expect(sample.mile).toBeCloseTo(100, 3);
    act(() => advance(1_200));
    expect(onTruck.mock.calls.at(-1)![0].stop?.label).toBe("30-min break");
    act(() => advance(400));
    sample = onTruck.mock.calls.at(-1)![0];
    expect(sample.stop).toBeNull();
    expect(sample.mile).toBeGreaterThan(100);
    expect(onHour.mock.calls.length).toBeGreaterThan(1);

    act(() => advance(2_000));
    sample = onTruck.mock.calls.at(-1)![0];
    expect(result.current.status).toBe("finished");
    expect(sample.mile).toBe(200);
    expect(queue.size).toBe(0);
  });

  it("seeks and skips anywhere in the trip, backwards too, clamped to the trip", () => {
    const { result, onTruck, onHour } = setup();
    act(() => result.current.seek(T0 + 3.5 * HOUR));
    expect(result.current.status).toBe("paused");
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeCloseTo(150, 0);
    // The forecast frame follows the truck's instant (3.5 h in rounds to frame 4).
    expect(onHour).toHaveBeenLastCalledWith(4);
    act(() => result.current.skip(-60));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeLessThan(150);
    act(() => result.current.skip(-24 * 60));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBe(0);
    act(() => result.current.seek(T0 + 99 * HOUR));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBe(200);
    expect(queue.size).toBe(0);
  });

  it("pauses without leaking a frame, resumes from the same place, and stop removes the truck", () => {
    const { result, onTruck, onHour, onPlaying } = setup();
    act(() => result.current.play());
    act(() => advance(400));
    act(() => result.current.pause());
    expect(queue.size).toBe(0);
    expect(onPlaying).toHaveBeenLastCalledWith(false);
    const at = onTruck.mock.calls.at(-1)![0].mile;
    act(() => advance(500));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBe(at);
    act(() => result.current.play());
    act(() => advance(100));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeGreaterThan(at);

    act(() => result.current.stop());
    expect(queue.size).toBe(0);
    expect(result.current.status).toBe("idle");
    expect(onTruck).toHaveBeenLastCalledWith(null);
    expect(onHour).toHaveBeenLastCalledWith(null);
  });

  it("clears the loop and the truck on unmount", () => {
    const { result, unmount, onTruck, onHour, onPlaying } = setup();
    act(() => result.current.play());
    act(() => advance(100));
    expect(queue.size).toBe(1);
    unmount();
    expect(queue.size).toBe(0);
    expect(onTruck).toHaveBeenLastCalledWith(null);
    expect(onHour).toHaveBeenLastCalledWith(null);
    expect(onPlaying).toHaveBeenLastCalledWith(false);
  });

  it("does not animate under reduced motion and steps checkpoint by checkpoint instead", () => {
    const { result, onTruck, onHour } = setup(true);
    act(() => result.current.play());
    expect(result.current.status).toBe("idle");
    expect(queue.size).toBe(0);

    act(() => result.current.step(1));
    expect(result.current.stepIndex).toBe(0);
    expect(onTruck.mock.calls.at(-1)![0].mile).toBe(0);
    act(() => result.current.step(1));
    act(() => result.current.step(1));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeCloseTo(100, 3);
    expect(onHour).toHaveBeenLastCalledWith(2);
    act(() => result.current.step(-1));
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeCloseTo(50, 3);
    for (let i = 0; i < 10; i += 1) act(() => result.current.step(1));
    expect(result.current.stepIndex).toBe(4);
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeCloseTo(200, 3);
    expect(queue.size).toBe(0);
  });

  it("caps a long gap between frames so a hidden tab does not teleport the truck", () => {
    const { result, onTruck } = setup();
    act(() => result.current.play());
    act(() => {
      clock += 30_000;
      const [[, callback]] = [...queue.entries()];
      queue = new Map();
      callback(clock);
    });
    expect(onTruck.mock.calls.at(-1)![0].mile).toBeLessThan(10);
  });
});
