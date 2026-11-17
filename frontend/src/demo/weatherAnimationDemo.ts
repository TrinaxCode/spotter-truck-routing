/**
 * Standalone harness for the weather animation (not part of the app bundle).
 * Open /weather-animation-demo.html with optional query parameters:
 *   variable=wind|rain|snow|risk   hour=0..15   theme=dark|light   pitch=0..60   zoom=n   bearing=n
 *   center=lon,lat   basemap=online|plain   mode=layer|overlay   reduced=1   dir=real|synth|none   hud=1
 * `window.__wx` exposes the map, the engine and a few helpers to scripts.
 */
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { HeatmapResponse, HeatVariable } from "../api/types";
import { corridorFeatures, heatmapFillColor, heatmapFillOpacity, radarRadius } from "../lib/heatmap";
import { createWeatherAnimation, type WeatherAnimation, type WeatherMode, type WeatherTheme } from "../map/weatherAnimation";
import sample from "../mocks/backend-heatmap.sample.json";

maplibregl.setWorkerUrl(workerUrl);

const params = new URLSearchParams(window.location.search);
const theme: WeatherTheme = params.get("theme") === "light" ? "light" : "dark";
const variable = (params.get("variable") ?? "wind") as HeatVariable;
const mode = (params.get("mode") ?? "layer") as WeatherMode;
let hour = Number(params.get("hour") ?? 6);
const reduced = params.get("reduced") === "1";

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

function plainStyle(t: WeatherTheme): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "bg", type: "background", paint: { "background-color": t === "dark" ? "#141b26" : "#e6e9ee" } }],
  };
}

/** The sample may carry no wind_dir; give it a believable circulation so the flow can be judged. */
function withDirections(base: HeatmapResponse, how: string): HeatmapResponse {
  const heat = structuredClone(base) as HeatmapResponse;
  if (how === "none") {
    delete heat.wind_dir;
    return heat;
  }
  const hasReal = heat.wind_dir?.some((row) => row.some((v) => v != null));
  if (how === "real" || (how !== "synth" && hasReal)) return heat;
  const centre = { lat: 35.4, lon: -101.8 };
  heat.wind_dir = heat.cells.map((cell, i) =>
    (heat.wind[i] ?? []).map((speed, h) => {
      if (speed == null) return null;
      const dLon = (cell.lon - centre.lon) * Math.cos((centre.lat * Math.PI) / 180);
      const dLat = cell.lat - centre.lat;
      const bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
      const swirl = ((bearing + 90 + h * 2) * Math.PI) / 180;
      const weight = Math.exp(-Math.hypot(dLon, dLat) / 3.5);
      const bg = ((258 + 20 * Math.sin(cell.lat * 0.6)) * Math.PI) / 180;
      const x = Math.sin(swirl) * weight + Math.sin(bg) * (1 - weight);
      const y = Math.cos(swirl) * weight + Math.cos(bg) * (1 - weight);
      return Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
    }),
  );
  return heat;
}

const heat = withDirections(sample as unknown as HeatmapResponse, params.get("dir") ?? "auto");

const map = new maplibregl.Map({
  container: "map",
  style: params.get("basemap") === "plain" ? plainStyle(theme) : STYLES[theme],
  center: (params.get("center") ?? "-101.2,36.1").split(",").map(Number) as [number, number],
  zoom: Number(params.get("zoom") ?? 5.6),
  pitch: Number(params.get("pitch") ?? 0),
  bearing: Number(params.get("bearing") ?? 0),
  maxPitch: 70,
  attributionControl: false,
  fadeDuration: 0,
});
document.body.style.background = theme === "dark" ? "#0b1017" : "#e9edf2";
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");

let animation: WeatherAnimation | null = null;

function install(): void {
  map.addSource("corridor", { type: "geojson", data: corridorFeatures(heat), maxzoom: 0 });
  map.addLayer({
    id: "corridor",
    type: "circle",
    source: "corridor",
    paint: {
      "circle-color": heatmapFillColor(variable, Math.floor(hour)) as never,
      "circle-opacity": heatmapFillOpacity(variable, Math.floor(hour), true, theme === "light" ? 0.85 : 1) as never,
      "circle-radius": radarRadius(heat.cell_deg) as never,
      "circle-blur": 0.85,
      "circle-pitch-alignment": "map",
      "circle-pitch-scale": "map",
    },
  });
  // A stand-in for the app's route lines: the animation must sit under this layer.
  const line: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: [[-96.8, 32.8], [-98.5, 34.2], [-101.8, 35.2], [-104.0, 36.6], [-105.0, 39.7]] },
  };
  map.addSource("route", { type: "geojson", data: line });
  map.addLayer({ id: "routes-other-casing", type: "line", source: "route", paint: { "line-color": theme === "dark" ? "#0a0f1a" : "#fff", "line-width": 9 } });
  map.addLayer({ id: "route-selected", type: "line", source: "route", paint: { "line-color": theme === "dark" ? "#5b9dff" : "#1d5cf0", "line-width": 5 } });

  animation = createWeatherAnimation(map, {
    reducedMotion: () => reduced,
    beforeId: "routes-other-casing",
    mode,
    theme,
    adaptive: params.get("adaptive") === "1",
  });
  animation.setData(heat);
  animation.setFrame(hour, variable, true);

  function setFrame(nextHour: number, nextVariable: HeatVariable): void {
    hour = nextHour;
    map.setPaintProperty("corridor", "circle-color", heatmapFillColor(nextVariable, Math.floor(nextHour)) as never);
    map.setPaintProperty("corridor", "circle-opacity", heatmapFillOpacity(nextVariable, Math.floor(nextHour), true, theme === "light" ? 0.85 : 1) as never);
    animation?.setFrame(nextHour, nextVariable, true);
  }
  Object.assign(window, { __wx: { map, animation, setFrame, heat, ready: true } });

  if (params.get("hud") === "1") {
    const hud = document.getElementById("hud");
    if (hud) {
      hud.hidden = false;
      setInterval(() => {
        const d = animation?.debug();
        if (d) hud.textContent = `${d.mode} ${d.kind} active ${d.activeParticles}/${d.capacity} alive ${d.aliveParticles} gain ${d.gain.toFixed(2)} scale ${d.budgetScale.toFixed(2)}`;
      }, 300);
    }
  }
}

if (map.isStyleLoaded()) install();
else map.once("style.load", install);
