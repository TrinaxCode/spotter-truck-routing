import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Map as LibreMap } from "maplibre-gl";
import type { HeatmapResponse } from "../src/api/types";

const fixture = JSON.parse(readFileSync(new URL("../src/mocks/heatmap.json", import.meta.url), "utf8")) as HeatmapResponse;

type RadarWindow = Window & {
  radarMap: LibreMap;
  radarCalls: { paint: number; sources: number; data: number; layers: number };
};

// Observe the real MapLibre APIs, without exposing a mutation hook in production.
async function observeMap(page: Page) {
  await page.locator(".maplibregl-canvas").waitFor();
  await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").find((entry) => /\/maplibre-gl\.js/.test(entry.name))?.name;
    if (!url) throw new Error("MapLibre module was not loaded");
    const { Map, GeoJSONSource } = await import(/* @vite-ignore */ url);
    const win = window as RadarWindow;
    win.radarCalls = { paint: 0, sources: 0, data: 0, layers: 0 };
    const paint = Map.prototype.setPaintProperty;
    Map.prototype.setPaintProperty = function (...args: unknown[]) {
      win.radarMap = this;
      win.radarCalls.paint++;
      return paint.apply(this, args);
    };
    for (const [method, counter] of [["addSource", "sources"], ["addLayer", "layers"]] as const) {
      const original = Map.prototype[method];
      Map.prototype[method] = function (...args: unknown[]) {
        win.radarCalls[counter]++;
        return original.apply(this, args);
      };
    }
    const data = GeoJSONSource.prototype.setData;
    GeoJSONSource.prototype.setData = function (...args: unknown[]) {
      win.radarCalls.data++;
      return data.apply(this, args);
    };
  });
}

async function start(page: Page, heat?: HeatmapResponse) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  // Offline, deterministic basemaps. Visual review uses the real styles separately.
  await page.route("https://tiles.openfreemap.org/**", (route) => route.fulfill({ json: {
    version: 8, sources: { labels: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, layers: [{ id: "background", type: "background", paint: {
      "background-color": route.request().url().includes("positron") ? "#e8ecef" : "#171e28",
    } }, { id: "labels", type: "symbol", source: "labels" }],
  } }));
  if (heat) {
    await page.route("**/src/mocks/heatmap.json*", (route) => route.fulfill({
      contentType: "text/javascript", body: `export default ${JSON.stringify(heat)}`,
    }));
  }
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Plan routes" })).toBeEnabled();
  await observeMap(page);
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByTestId("heatmap-slider")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as RadarWindow).radarMap?.isStyleLoaded()))).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => {
    const map = (window as RadarWindow).radarMap;
    if (map.loaded()) resolve();
    else map.once("idle", () => resolve());
  }));
  return errors;
}

async function counters(page: Page) {
  return page.evaluate(() => ({ ...window.__spotter, ...(window as RadarWindow).radarCalls }));
}

async function pixels(page: Page, coordinates: [number, number][]) {
  await expect.poll(() => page.evaluate(() => (window as RadarWindow).radarMap.loaded())).toBe(true);
  return page.evaluate((locations) => new Promise<number[][]>((resolve) => {
    const map = (window as RadarWindow).radarMap;
    map.once("render", () => {
      const canvas = map.getCanvas();
      const gl = canvas.getContext("webgl2")!;
      resolve(locations.map((location) => {
        const point = map.project(location);
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.round(point.x * canvas.width / canvas.clientWidth),
          canvas.height - 1 - Math.round(point.y * canvas.height / canvas.clientHeight),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return Array.from(pixel);
      }));
    });
    map.triggerRepaint();
  }), coordinates);
}

test("radar frames and all four variables change paint only, including hour 48 and theme restore", async ({ page }) => {
  const errors = await start(page);
  const layer = await page.evaluate(() => (window as RadarWindow).radarMap.getStyle().layers.find((item) => item.id === "corridor"));
  expect(layer?.type).toBe("circle");
  expect(layer?.paint).toMatchObject({ "circle-blur": 0.85, "circle-pitch-alignment": "map", "circle-pitch-scale": "map" });
  const ids = await page.evaluate(() => (window as RadarWindow).radarMap.getStyle().layers.map((item) => item.id));
  expect(ids.indexOf("corridor")).toBeLessThan(ids.indexOf("route-selected"));
  expect(ids.indexOf("corridor-grid")).toBeLessThan(ids.indexOf("labels"));
  const before = await counters(page);
  const slider = page.getByTestId("heatmap-slider");
  for (const variable of ["Wind", "Rain", "Snow", "Risk"]) {
    await page.getByRole("radio", { name: variable, exact: true }).click();
    await slider.focus();
    await slider.press("End");
    await expect.poll(() => page.evaluate(() => window.__spotter?.frame)).toBe(48);
    await slider.press("Home");
    await slider.press("ArrowRight");
  }
  const after = await counters(page);
  for (const key of ["sourceUpdates", "mapRenders", "sources", "data", "layers"] as const) expect(after[key]).toBe(before[key]);
  expect(after.paint).toBeGreaterThan(before.paint);
  expect(after.paintUpdates! - before.paintUpdates!).toBe(after.paint - before.paint);
  expect(after.variable).toBe("risk");
  expect(after.frame).toBe(1);
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect.poll(() => page.evaluate(() => (window as RadarWindow).radarMap.isStyleLoaded())).toBe(true);
  expect(await page.evaluate(() => (window as RadarWindow).radarMap.getLayer("corridor")?.type)).toBe("circle");
  const restored = await counters(page);
  await slider.press("End");
  const end = await counters(page);
  expect(end.sourceUpdates).toBe(restored.sourceUpdates);
  expect(end.data).toBe(restored.data);
  expect(errors).toEqual([]);
});

test("null cells and the unavailable final frame leave the rendered basemap untouched", async ({ page }) => {
  const heat = structuredClone(fixture) as HeatmapResponse;
  heat.cells = [{ lon: -101, lat: 37 }, { lon: -99, lat: 37 }];
  for (const variable of ["risk", "wind", "rain", "snow"] as const) {
    heat[variable] = [Array(49).fill(null), Array(49).fill(variable === "risk" ? 4 : 60)];
    heat[variable][1][48] = null;
  }
  const errors = await start(page, heat);
  await page.evaluate(() => (window as RadarWindow).radarMap.jumpTo({ center: [-100, 37], zoom: 7, padding: { top: 0, bottom: 0, left: 0, right: 0 } }));
  for (const variable of ["Risk", "Wind", "Rain", "Snow"]) {
    await page.getByRole("radio", { name: variable, exact: true }).click();
    await page.getByTestId("heatmap-slider").press("Home");
    const [unknown, known] = await pixels(page, [[-101, 37], [-99, 37]]);
    expect(unknown).toEqual([23, 30, 40, 255]);
    expect(known).not.toEqual(unknown);
    await page.getByTestId("heatmap-slider").press("End");
    expect(await pixels(page, [[-101, 37], [-99, 37]])).toEqual([unknown, unknown]);
  }
  expect(errors).toEqual([]);
});

test("a uniform field blends across cell junctions without dark holes", async ({ page }) => {
  const heat = structuredClone(fixture) as HeatmapResponse;
  heat.cell_deg = 0.4;
  heat.cells = Array.from({ length: 49 }, (_, index) => ({
    lon: -100 + (index % 7 - 3) * 0.4, lat: 37 + (Math.floor(index / 7) - 3) * 0.4,
  }));
  for (const variable of ["risk", "wind", "rain", "snow"] as const) {
    heat[variable] = heat.cells.map(() => Array(49).fill(variable === "risk" ? 3 : 45));
  }
  await start(page, heat);
  await page.evaluate(() => {
    const map = (window as RadarWindow).radarMap;
    for (const layer of map.getStyle().layers) if (layer.source && layer.source !== "corridor") map.setLayoutProperty(layer.id, "visibility", "none");
    map.jumpTo({ center: [-100, 37], zoom: 7, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
  });
  const [centre, junction] = await pixels(page, [[-100, 37], [-99.8, 37.2]]);
  // Red-channel contribution above the dark basemap stays within 25% across a cell.
  expect(junction[0] - 23).toBeGreaterThan((centre[0] - 23) * 0.75);
});

test("the field keeps its geographic footprint when the sample centre leaves a high-zoom viewport", async ({ page }) => {
  const heat = structuredClone(fixture) as HeatmapResponse;
  heat.cell_deg = 0.75;
  // Straddle a source-tile boundary at z6, then zoom into the neighbouring tile.
  heat.cells = [{ lon: -101.4, lat: 37 }];
  for (const variable of ["risk", "wind", "rain", "snow"] as const) heat[variable] = [Array(49).fill(variable === "risk" ? 3 : 45)];
  await start(page, heat);
  const point: [number, number] = [-100.95, 37];
  const samples: number[][] = [];
  for (const [zoom, pitch] of [[7, 0], [11, 0], [11, 60]]) {
    await page.evaluate(({ point, zoom, pitch }) => {
      const map = (window as RadarWindow).radarMap;
      map.jumpTo({ center: point, zoom, pitch, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }, { point, zoom, pitch });
    samples.push((await pixels(page, [point]))[0]);
  }
  expect(samples[0][0]).toBeGreaterThan(40);
  for (const sample of samples.slice(1)) expect(Math.abs(samples[0][0] - sample[0])).toBeLessThan(8);
});

test("visibility fades with paint only and reduced motion hides immediately", async ({ page }) => {
  await start(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const before = await counters(page);
  const toggle = page.getByRole("button", { name: "Show heatmap", exact: true });
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as RadarWindow).radarMap.getPaintProperty("corridor", "circle-opacity"))).toBe(0);
  const hidden = await counters(page);
  // Several animation frames, each counted as paint, finish the existing fade.
  expect(hidden.paint - before.paint).toBeGreaterThan(8);
  await toggle.click();
  await expect.poll(async () => Array.isArray(await page.evaluate(() => (window as RadarWindow).radarMap.getPaintProperty("corridor", "circle-opacity")))).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle.click();
  expect(await page.evaluate(() => (window as RadarWindow).radarMap.getPaintProperty("corridor", "circle-opacity"))).toBe(0);
  const after = await counters(page);
  expect(after.data).toBe(before.data);
  expect(after.sources).toBe(before.sources);
  expect(after.mapRenders).toBe(before.mapRenders);
});
