import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeatmapResponse } from "../api/types";
import { latToMercY, lonToMercX, mercXToLon, mercYToLat } from "../lib/windField";
import { createWeatherAnimation, WEATHER_LAYER_ID, type WeatherAnimation, type WeatherAnimationOptions } from "./weatherAnimation";

const WIDTH = 800;
const HEIGHT = 600;
const ZOOM = 6;
const WORLD = 512 * 2 ** ZOOM;

type Listener = (...args: unknown[]) => void;

function mockMap() {
  const listeners = new Map<string, Set<Listener>>();
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: WIDTH });
  Object.defineProperty(canvas, "clientHeight", { value: HEIGHT });
  const container = document.createElement("div");
  container.appendChild(canvas);
  const layers = new Map<string, unknown>();
  const center = { lng: -100, lat: 36 };
  const map = {
    on: vi.fn((event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    getCanvas: () => canvas,
    getCanvasContainer: () => container,
    getCenter: () => center,
    getZoom: () => ZOOM,
    getBearing: () => 0,
    getPitch: () => 0,
    unproject: ([x, y]: [number, number]) => ({
      lng: mercXToLon(lonToMercX(center.lng) + (x - WIDTH / 2) / WORLD),
      lat: mercYToLat(latToMercY(center.lat) + (y - HEIGHT / 2) / WORLD),
    }),
    addLayer: vi.fn((layer: { id: string }) => {
      layers.set(layer.id, layer);
    }),
    removeLayer: vi.fn((id: string) => {
      layers.delete(id);
    }),
    moveLayer: vi.fn(),
    getLayer: (id: string) => layers.get(id),
    triggerRepaint: vi.fn(),
  };
  const count = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener());
  return { map, count, emit, container, canvas, layers };
}

function heat(withDir: boolean): HeatmapResponse {
  const cells: { lat: number; lon: number }[] = [];
  for (let j = 0; j < 5; j += 1) for (let i = 0; i < 5; i += 1) cells.push({ lon: -100.5 + i * 0.5, lat: 35 + j * 0.5 });
  const row = (value: number) => Array.from({ length: 49 }, () => value);
  return {
    plan_id: "t",
    start: "2026-11-16T14:00:00Z",
    hours: 49,
    cell_deg: 0.5,
    load_lbs: 30000,
    cells,
    risk: cells.map(() => row(1)),
    wind: cells.map(() => row(28)),
    rain: cells.map(() => row(0.25)),
    snow: cells.map(() => row(0.6)),
    ...(withDir ? { wind_dir: cells.map(() => row(270)) } : {}),
  };
}

function canvasContextStub() {
  const calls = { stroke: 0, drawImage: 0, clearRect: 0 };
  const target: Record<string, unknown> = {};
  const proxy: CanvasRenderingContext2D = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "stroke") return () => (calls.stroke += 1);
      if (prop === "drawImage") return () => (calls.drawImage += 1);
      if (prop === "clearRect") return () => (calls.clearRect += 1);
      if (prop === "createRadialGradient") return () => ({ addColorStop: () => undefined });
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(_t, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { proxy, calls };
}

let hidden = false;
let reduced = false;
let pending = new Map<number, (time: number) => void>();
let nextHandle = 1;
const requestFrame = vi.fn((callback: (time: number) => void) => {
  const handle = nextHandle++;
  pending.set(handle, callback);
  return handle;
});
const cancelFrame = vi.fn((handle: number) => {
  pending.delete(handle);
});
let clock = 1000;

/** Runs every queued animation callback once, advancing the clock. */
function flush(frames = 1, stepMs = 16): void {
  for (let n = 0; n < frames; n += 1) {
    clock += stepMs;
    const callbacks = [...pending.values()];
    pending = new Map();
    for (const callback of callbacks) callback(clock);
  }
}

function make(overrides: Partial<WeatherAnimationOptions> = {}) {
  const harness = mockMap();
  const animation = createWeatherAnimation(harness.map as unknown as MapLibreMap, {
    reducedMotion: () => reduced,
    mode: "overlay",
    adaptive: false,
    requestFrame,
    cancelFrame,
    now: () => clock,
    ...overrides,
  });
  return { ...harness, animation };
}

let ctx: ReturnType<typeof canvasContextStub>;
let animations: WeatherAnimation[] = [];

beforeEach(() => {
  hidden = false;
  reduced = false;
  pending = new Map();
  nextHandle = 1;
  clock = 1000;
  requestFrame.mockClear();
  cancelFrame.mockClear();
  ctx = canvasContextStub();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctx.proxy) as never);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  animations = [];
});

afterEach(() => {
  for (const animation of animations) animation.destroy();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "hidden");
});

function started(overrides: Partial<WeatherAnimationOptions> = {}) {
  const made = make(overrides);
  animations.push(made.animation);
  return made;
}

describe("weather animation lifecycle", () => {
  it("animates only while it is visible with data: RAF runs, particles appear, nothing is drawn before", () => {
    const { animation } = started();
    expect(requestFrame).not.toHaveBeenCalled();
    animation.setFrame(3, "wind", true);
    expect(requestFrame).not.toHaveBeenCalled();
    animation.setData(heat(true));
    animation.setFrame(3, "wind", true);
    expect(requestFrame).toHaveBeenCalled();
    flush(40);
    const debug = animation.debug();
    expect(debug.mappingValid).toBe(true);
    expect(debug.aliveParticles).toBeGreaterThan(0);
    expect(debug.activeParticles).toBeGreaterThan(0);
    expect(debug.running).toBe(true);
    expect(ctx.calls.stroke).toBeGreaterThan(0);
  });

  it("starts no RAF when the page is hidden and resumes when it is shown", () => {
    hidden = true;
    const { animation } = started();
    animation.setData(heat(true));
    animation.setFrame(3, "wind", true);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(animation.debug().running).toBe(false);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(requestFrame).toHaveBeenCalled();
    expect(animation.debug().running).toBe(true);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animation.debug().running).toBe(false);
    expect(cancelFrame).toHaveBeenCalled();
  });

  it("starts no RAF under reduced motion and draws one still frame (arrows, not trails)", () => {
    reduced = true;
    const { animation } = started();
    animation.setData(heat(true));
    animation.setFrame(3, "wind", true);
    expect(requestFrame).not.toHaveBeenCalled();
    const debug = animation.debug();
    expect(debug.reduced).toBe(true);
    expect(debug.running).toBe(false);
    expect(debug.aliveParticles).toBe(0);
    expect(debug.gain).toBe(1);
    expect(ctx.calls.stroke).toBeGreaterThan(0);
  });

  it("draws still dots for snow under reduced motion", () => {
    reduced = true;
    const { animation } = started();
    animation.setData(heat(true));
    animation.setFrame(3, "snow", true);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(ctx.calls.drawImage).toBeGreaterThan(0);
  });

  it("stops the loop once an invisible layer has faded out, and restarts when shown again", () => {
    const { animation } = started();
    animation.setData(heat(true));
    animation.setFrame(3, "wind", true);
    flush(30);
    animation.setFrame(3, "wind", false);
    flush(60);
    expect(animation.debug().gain).toBe(0);
    expect(pending.size).toBe(0);
    expect(animation.debug().running).toBe(false);
    animation.setFrame(3, "wind", true);
    expect(pending.size).toBe(1);
  });

  it("does not crash and still flows when wind_dir is missing", () => {
    const { animation } = started();
    animation.setData(heat(false));
    animation.setFrame(2, "wind", true);
    flush(40);
    expect(animation.debug().aliveParticles).toBeGreaterThan(0);
    expect(animation.debug().realDirections).toBe(0);
  });

  it("shows rain, snow and a subtle wind under risk", () => {
    const { animation } = started();
    animation.setData(heat(true));
    for (const variable of ["rain", "snow", "risk"] as const) {
      animation.setFrame(2, variable, true);
      flush(40);
      const debug = animation.debug();
      expect(debug.kind).toBe(variable === "risk" ? "wind" : variable);
      expect(debug.aliveParticles).toBeGreaterThan(0);
    }
  });

  it("copes with no data, empty data and data that arrives after the frame", () => {
    const { animation } = started();
    animation.setFrame(1, "wind", true);
    animation.setData(null);
    animation.setData({ ...heat(true), cells: [], risk: [], wind: [], rain: [], snow: [] });
    flush(5);
    expect(animation.debug().aliveParticles).toBe(0);
    animation.setData(heat(true));
    flush(30);
    expect(animation.debug().aliveParticles).toBeGreaterThan(0);
  });
});

describe("weather animation allocation", () => {
  it("setFrame reuses every buffer: hours and variables change without reallocation", () => {
    const { animation } = started();
    animation.setData(heat(true));
    animation.setFrame(0, "wind", true);
    flush(10);
    const before = animation.debug().buffers;
    for (let hour = 1; hour < 30; hour += 1) {
      animation.setFrame(hour + 0.37, hour % 2 ? "wind" : "risk", true);
      flush(2);
    }
    animation.setFrame(5, "rain", true);
    animation.setFrame(6, "snow", true);
    animation.setFrame(7, "wind", true);
    flush(5);
    const after = animation.debug().buffers;
    expect(after.fieldU).toBe(before.fieldU);
    expect(after.windX).toBe(before.windX);
    expect(after.precipX).toBe(before.precipX);
    expect(after.table).toBe(before.table);
    expect(after.scratch).toBe(before.scratch);
  });

  it("keeps exactly one RAF pending however often the frame changes", () => {
    const { animation } = started();
    animation.setData(heat(true));
    for (let hour = 0; hour < 20; hour += 1) animation.setFrame(hour, "wind", true);
    expect(pending.size).toBe(1);
    flush(3);
    expect(pending.size).toBe(1);
  });

  it("caps particles at the configured maximum", () => {
    const { animation } = started({ maxParticles: 500 });
    animation.setData(heat(true));
    animation.setFrame(1, "wind", true);
    flush(30);
    expect(animation.debug().capacity).toBeLessThanOrEqual(500);
    expect(animation.debug().activeParticles).toBeLessThanOrEqual(500);
  });
});

describe("weather animation teardown", () => {
  it("destroy removes every listener, cancels the RAF and the overlay canvas", () => {
    const { animation, map, count, container } = started();
    animation.setData(heat(true));
    animation.setFrame(1, "wind", true);
    expect(count()).toBeGreaterThan(0);
    expect(container.querySelector("canvas[data-weather-animation]")).not.toBeNull();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    animation.destroy();
    expect(count()).toBe(0);
    expect(map.off).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(container.querySelector("canvas[data-weather-animation]")).toBeNull();
    expect(pending.size).toBe(0);
    requestFrame.mockClear();
    animation.setFrame(2, "wind", true);
    animation.setData(heat(true));
    expect(requestFrame).not.toHaveBeenCalled();
    expect(() => animation.destroy()).not.toThrow();
  });

  it("the overlay canvas is inert for assistive tech and pointers", () => {
    const { container } = started();
    const overlay = container.querySelector<HTMLCanvasElement>("canvas[data-weather-animation]");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay?.style.pointerEvents).toBe("none");
  });
});

describe("weather animation layer mode", () => {
  it("inserts a custom layer under beforeId and removes it on destroy", () => {
    const harness = mockMap();
    harness.layers.set("routes-other-casing", {});
    const animation = createWeatherAnimation(harness.map as unknown as MapLibreMap, {
      reducedMotion: () => false,
      mode: "layer",
      beforeId: () => "routes-other-casing",
      requestFrame,
      cancelFrame,
      now: () => clock,
    });
    expect(harness.map.addLayer).toHaveBeenCalledTimes(1);
    const [layer, before] = harness.map.addLayer.mock.calls[0] as unknown as [{ id: string; type: string }, string];
    expect(layer.id).toBe(WEATHER_LAYER_ID);
    expect(layer.type).toBe("custom");
    expect(before).toBe("routes-other-casing");
    // After a basemap swap the style drops custom layers; style.load puts it back.
    harness.layers.delete(WEATHER_LAYER_ID);
    harness.emit("style.load");
    expect(harness.map.addLayer).toHaveBeenCalledTimes(2);
    animation.restack();
    expect(harness.map.moveLayer).toHaveBeenCalledWith(WEATHER_LAYER_ID, "routes-other-casing");
    animation.destroy();
    expect(harness.map.removeLayer).toHaveBeenCalledWith(WEATHER_LAYER_ID);
    expect(harness.count()).toBe(0);
  });

  it("drives the map with repaint requests instead of drawing on its own", () => {
    const harness = mockMap();
    const animation = createWeatherAnimation(harness.map as unknown as MapLibreMap, {
      reducedMotion: () => false,
      mode: "layer",
      requestFrame,
      cancelFrame,
      now: () => clock,
    });
    animations.push(animation);
    animation.setData(heat(true));
    animation.setFrame(1, "wind", true);
    flush(3);
    expect(harness.map.triggerRepaint).toHaveBeenCalled();
    animation.destroy();
    harness.map.triggerRepaint.mockClear();
    flush(3);
    expect(harness.map.triggerRepaint).not.toHaveBeenCalled();
  });

  it("falls back to the first free spot when beforeId is not (yet) in the style", () => {
    const harness = mockMap();
    const animation = createWeatherAnimation(harness.map as unknown as MapLibreMap, {
      reducedMotion: () => false,
      mode: "layer",
      beforeId: "missing-layer",
      requestFrame,
      cancelFrame,
    });
    animations.push(animation);
    expect((harness.map.addLayer.mock.calls[0] as unknown[])[1]).toBeUndefined();
  });
});
