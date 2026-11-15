import * as maplibregl from "maplibre-gl";
import type { AllPaintProperties, FilterSpecification, GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

maplibregl.setWorkerUrl(workerUrl);
import type { HeatmapResponse, HeatVariable, PlanResponse } from "../api/types";
import { corridorFeatures, heatmapFillColor, heatmapFillOpacity, type PaintExpr } from "../lib/heatmap";
import { formatClock, formatInchesPerHour, formatMiles, formatSpeedMph, formatTempF } from "../lib/format";
import { NEUTRAL_ROUTE_COLOR, riskColor } from "../lib/riskColor";
import { segmentRoute } from "../lib/routeSegments";
import { etaHourIndex } from "../lib/time";
import type { MapHandle } from "./handle";

export type { MapHandle } from "./handle";

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const ROUTE_SOURCE = "routes";
const SEGMENT_SOURCE = "segments";
const CHECKPOINT_SOURCE = "checkpoints";
const CORRIDOR_SOURCE = "corridor";

export interface MapControllerOptions {
  theme: "light" | "dark";
  onReady: (handle: MapHandle) => void;
  onInspect: (routeId: string, index: number) => void;
  onSelect: (routeId: string) => void;
}

interface CheckpointHit {
  routeId: string;
  index: number;
  lon: number;
  lat: number;
}

function ensureProbe(): SpotterProbe {
  window.__spotter ??= {
    sourceUpdates: 0,
    paintUpdates: 0,
    mapRenders: 0,
    frame: 0,
    variable: "risk",
  };
  return window.__spotter;
}

export function noteMapRender(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  ensureProbe().mapRenders += 1;
}

export function createMapController(container: HTMLElement, options: MapControllerOptions): MapHandle {
  const theme = options.theme === "dark" ? "dark" : "light";
  const map = new maplibregl.Map({
    container,
    style: STYLES[theme],
    center: [-100.4, 36.4],
    zoom: 4.1,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: 0,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");
  map.touchZoomRotate.disableRotation();
  // MapLibre opens the compact attribution (compact-show) the first time credits
  // arrive, which covers the route on a short map. Collapse it once, after that.
  const collapseAttrib = () => {
    if (window.innerWidth > 768) return;
    const el = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
    const inner = el?.querySelector(".maplibregl-ctrl-attrib-inner");
    if (!el || el.classList.contains("maplibregl-attrib-empty") || !inner?.textContent?.trim()) return;
    el.classList.remove("maplibregl-compact-show");
    el.removeAttribute("open");
    map.off("sourcedata", collapseAttrib);
    map.off("idle", collapseAttrib);
  };
  map.on("sourcedata", collapseAttrib);
  map.on("idle", collapseAttrib);

  const tip = document.createElement("div");
  tip.className = "map-tip";
  tip.hidden = true;
  tip.setAttribute("aria-hidden", "true");
  container.append(tip);

  let alive = true;
  let styled = false;
  let booted = false;
  let plan: PlanResponse | null = null;
  let heat: HeatmapResponse | null = null;
  let selectedId = "";
  let hour = 0;
  let variable: HeatVariable = "risk";
  let heatVisible = true;
  const markers: maplibregl.Marker[] = [];
  const hits = new Map<string, CheckpointHit>();

  const resize = new ResizeObserver(() => {
    if (alive) map.resize();
  });
  resize.observe(container);

  map.on("error", (event) => {
    const message = event.error?.message ?? "";
    if (/ajax|tile|sprite|glyph|fetch|Failed to load/i.test(message)) return;
    console.warn(message);
  });

  function bumpSource(): void {
    if (import.meta.env.DEV) ensureProbe().sourceUpdates += 1;
  }

  function bumpPaint(): void {
    if (!import.meta.env.DEV) return;
    const probe = ensureProbe();
    probe.paintUpdates += 1;
    probe.frame = hour;
    probe.variable = variable;
  }

  function geoSource(id: string): GeoJSONSource | null {
    const source = map.getSource(id);
    if (!source || source.type !== "geojson") return null;
    return source as GeoJSONSource;
  }

  function writeSource(id: string, data: GeoJSON.FeatureCollection): void {
    geoSource(id)?.setData(data);
    bumpSource();
  }

  function paint<K extends keyof AllPaintProperties>(
    layer: string,
    name: K,
    value: AllPaintProperties[K],
  ): void {
    if (!map.getLayer(layer)) return;
    map.setPaintProperty(layer, name, value);
    bumpPaint();
  }

  function paintExpr(layer: string, name: "fill-color" | "line-color", expr: PaintExpr): void {
    paint(layer, name, expr as AllPaintProperties["fill-color"]);
  }

  function addLayer(layer: maplibregl.LayerSpecification, beforeId?: string): void {
    if (map.getLayer(layer.id)) return;
    if (beforeId && map.getLayer(beforeId)) map.addLayer(layer, beforeId);
    else map.addLayer(layer);
  }

  function labelAnchor(): string | undefined {
    const layers = map.getStyle()?.layers ?? [];
    return layers.find((layer) => layer.type === "symbol")?.id;
  }

  function installLayers(): void {
    if (!map.getSource(CORRIDOR_SOURCE)) {
      map.addSource(CORRIDOR_SOURCE, { type: "geojson", data: EMPTY });
    }
    if (!map.getSource(ROUTE_SOURCE)) {
      map.addSource(ROUTE_SOURCE, { type: "geojson", data: EMPTY });
    }
    if (!map.getSource(SEGMENT_SOURCE)) {
      map.addSource(SEGMENT_SOURCE, { type: "geojson", data: EMPTY });
    }
    if (!map.getSource(CHECKPOINT_SOURCE)) {
      map.addSource(CHECKPOINT_SOURCE, { type: "geojson", data: EMPTY });
    }

    const lineLayout = { "line-cap": "round" as const, "line-join": "round" as const };
    addLayer({
      id: "routes-other-casing",
      type: "line",
      source: ROUTE_SOURCE,
      paint: { "line-color": "#f7f4ec", "line-width": 7, "line-opacity": 0.95 },
      layout: lineLayout,
    });
    addLayer({
      id: "routes-other",
      type: "line",
      source: ROUTE_SOURCE,
      paint: { "line-color": NEUTRAL_ROUTE_COLOR, "line-width": 4, "line-opacity": 1 },
      layout: lineLayout,
    });
    addLayer({
      id: "route-casing",
      type: "line",
      source: ROUTE_SOURCE,
      paint: { "line-color": "#14211b", "line-width": 12, "line-opacity": 0.95 },
      layout: lineLayout,
    });
    addLayer({
      id: "route-selected",
      type: "line",
      source: SEGMENT_SOURCE,
      paint: {
        "line-color": ["coalesce", ["get", "color"], NEUTRAL_ROUTE_COLOR],
        "line-width": 7,
        "line-opacity": 1,
      },
      layout: lineLayout,
    });
    addLayer({
      id: "checkpoints",
      type: "circle",
      source: CHECKPOINT_SOURCE,
      paint: {
        "circle-color": ["coalesce", ["get", "color"], "#5c6b64"],
        "circle-radius": 7,
        "circle-stroke-color": "#f7f4ec",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.95,
      },
    });
    addLayer({
      id: "checkpoint-hit",
      type: "circle",
      source: CHECKPOINT_SOURCE,
      paint: {
        "circle-color": "#14211b",
        "circle-radius": 22,
        "circle-opacity": 0.01,
        "circle-stroke-width": 0,
      },
    });
    addLayer(
      {
        id: "corridor",
        type: "fill",
        source: CORRIDOR_SOURCE,
        paint: {
          "fill-color": "rgba(0,0,0,0)",
          "fill-opacity": 0,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      },
      labelAnchor() ?? "routes-other-casing",
    );
  }

  function inSelectedHour(): AllPaintProperties["circle-stroke-width"] {
    return [
      "all",
      ["==", ["get", "routeId"], selectedId],
      ["==", ["get", "hour"], hour],
    ] as AllPaintProperties["circle-stroke-width"];
  }

  function paintCheckpoints(): void {
    const active = inSelectedHour();
    paint(
      "checkpoints",
      "circle-opacity",
      ["case", ["==", ["get", "routeId"], selectedId], 0.98, 0.55] as AllPaintProperties["circle-opacity"],
    );
    paint(
      "checkpoint-hit",
      "circle-opacity",
      ["case", ["==", ["get", "routeId"], selectedId], 0.01, 0.01] as AllPaintProperties["circle-opacity"],
    );
    paint(
      "checkpoints",
      "circle-stroke-width",
      ["case", active, 4, 1.5] as AllPaintProperties["circle-stroke-width"],
    );
    paint(
      "checkpoints",
      "circle-stroke-color",
      ["case", active, "#f0b429", "#f7f4ec"] as AllPaintProperties["circle-stroke-color"],
    );
    paint(
      "checkpoints",
      "circle-radius",
      ["case", active, 11, ["==", ["get", "routeId"], selectedId], 7, 5] as AllPaintProperties["circle-radius"],
    );
  }

  function applySelection(): void {
    const other: FilterSpecification = ["!=", ["get", "routeId"], selectedId];
    const selected: FilterSpecification = ["==", ["get", "routeId"], selectedId];
    for (const id of ["routes-other", "routes-other-casing"]) {
      if (map.getLayer(id)) map.setFilter(id, other);
    }
    for (const id of ["route-selected", "route-casing"]) {
      if (map.getLayer(id)) map.setFilter(id, selected);
    }
    paintCheckpoints();
  }

  function applyFrame(): void {
    paintExpr("corridor", "fill-color", heatmapFillColor(variable, hour));
    const opacity = heatmapFillOpacity(variable, hour, heatVisible && heat != null);
    paint("corridor", "fill-opacity", opacity as AllPaintProperties["fill-opacity"]);
    paintCheckpoints();
  }

  function routeCollection(next: PlanResponse): GeoJSON.FeatureCollection {
    return {
      type: "FeatureCollection",
      features: next.routes.map((route) => ({
        type: "Feature",
        properties: { routeId: route.id },
        geometry: route.geometry,
      })),
    };
  }

  function segmentCollection(next: PlanResponse): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (const route of next.routes) {
      for (const segment of segmentRoute(route)) {
        features.push({
          type: "Feature",
          properties: {
            routeId: route.id,
            color: riskColor(segment.level),
            level: segment.level,
          },
          geometry: { type: "LineString", coordinates: segment.coordinates },
        });
      }
    }
    return { type: "FeatureCollection", features };
  }

  function checkpointCollection(next: PlanResponse, startIso: string | null): GeoJSON.FeatureCollection {
    hits.clear();
    const features: GeoJSON.Feature[] = [];
    for (const route of next.routes) {
      for (const checkpoint of route.checkpoints) {
        const key = `${route.id}:${checkpoint.index}`;
        hits.set(key, {
          routeId: route.id,
          index: checkpoint.index,
          lon: checkpoint.lon,
          lat: checkpoint.lat,
        });
        const weather = checkpoint.weather;
        features.push({
          type: "Feature",
          properties: {
            routeId: route.id,
            index: checkpoint.index,
            hour: startIso ? etaHourIndex(startIso, checkpoint.eta) : -1,
            color: riskColor(checkpoint.level),
            mile: formatMiles(checkpoint.mile),
            eta: formatClock(checkpoint.eta),
            levelLabel: checkpoint.level_label || "Unknown",
            wind: weather ? formatSpeedMph(weather.wind_mph) : "Missing",
            gust: weather ? formatSpeedMph(weather.gust_mph) : "Missing",
            rain: weather ? formatInchesPerHour(weather.rain_in_hr) : "Missing",
            snow: weather ? formatInchesPerHour(weather.snow_in_hr) : "Missing",
            temp: weather ? formatTempF(weather.temp_f) : "Missing",
            reasons: checkpoint.reasons.join("; "),
          },
          geometry: { type: "Point", coordinates: [checkpoint.lon, checkpoint.lat] },
        });
      }
    }
    return { type: "FeatureCollection", features };
  }

  function syncMarkers(next: PlanResponse): void {
    for (const marker of markers) marker.remove();
    markers.length = 0;
    const pins: { kind: "Start" | "End"; label: string; lon: number; lat: number }[] = [
      { kind: "Start", label: next.request.origin.label, lon: next.request.origin.lon, lat: next.request.origin.lat },
      {
        kind: "End",
        label: next.request.destination.label,
        lon: next.request.destination.lon,
        lat: next.request.destination.lat,
      },
    ];
    for (const pin of pins) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = pin.kind === "Start" ? "map-pin map-pin-start" : "map-pin map-pin-end";
      button.textContent = pin.kind;
      button.setAttribute("aria-label", `${pin.kind === "Start" ? "Origin" : "Destination"}, ${pin.label}`);
      const marker = new maplibregl.Marker({ element: button, anchor: "center" })
        .setLngLat([pin.lon, pin.lat])
        .addTo(map);
      markers.push(marker);
    }
  }

  function fit(next: PlanResponse): void {
    const bounds = new maplibregl.LngLatBounds();
    for (const route of next.routes) {
      for (const coord of route.geometry.coordinates) bounds.extend(coord);
    }
    if (bounds.isEmpty()) return;
    const narrow = window.innerWidth <= 768;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.fitBounds(bounds, {
      padding: narrow
        ? { top: 44, bottom: 52, left: 10, right: 64 }
        : { top: 56, bottom: 36, left: 28, right: 64 },
      duration: reduce ? 0 : 500,
      maxZoom: 8,
    });
  }

  function applyPlan(): void {
    if (!plan || !styled) return;
    writeSource(ROUTE_SOURCE, routeCollection(plan));
    writeSource(SEGMENT_SOURCE, segmentCollection(plan));
    writeSource(CHECKPOINT_SOURCE, checkpointCollection(plan, heat?.start ?? plan.routes[0]?.departure ?? null));
    syncMarkers(plan);
    applySelection();
    fit(plan);
  }

  function applyHeat(): void {
    if (!styled) return;
    writeSource(CORRIDOR_SOURCE, heat ? corridorFeatures(heat) : EMPTY);
    if (plan) {
      writeSource(CHECKPOINT_SOURCE, checkpointCollection(plan, heat?.start ?? plan.routes[0]?.departure ?? null));
    }
    applyFrame();
  }

  function restore(): void {
    installLayers();
    if (plan) {
      writeSource(ROUTE_SOURCE, routeCollection(plan));
      writeSource(SEGMENT_SOURCE, segmentCollection(plan));
      writeSource(CHECKPOINT_SOURCE, checkpointCollection(plan, heat?.start ?? plan.routes[0]?.departure ?? null));
      syncMarkers(plan);
      applySelection();
    }
    if (heat) writeSource(CORRIDOR_SOURCE, corridorFeatures(heat));
    applyFrame();
  }

  map.on("style.load", () => {
    if (!alive) return;
    styled = true;
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    if (!map.getLayer("corridor")) restore();
    else applyFrame();
    if (!booted) {
      booted = true;
      options.onReady(handle);
    }
  });

  function selectRoute(event: { features?: maplibregl.MapGeoJSONFeature[] }): void {
    const routeId = event.features?.[0]?.properties?.routeId;
    if (typeof routeId === "string") options.onSelect(routeId);
  }

  for (const layerId of ["routes-other", "routes-other-casing", "route-selected", "route-casing"]) {
    map.on("click", layerId, selectRoute);
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  map.on("click", "checkpoint-hit", (event) => {
    const feature = event.features?.[0];
    const routeId = feature?.properties?.routeId;
    const index = feature?.properties?.index;
    if (typeof routeId === "string" && index != null) options.onInspect(routeId, Number(index));
  });

  map.on("mousemove", "checkpoint-hit", (event) => {
    const feature = event.features?.[0];
    const props = feature?.properties;
    if (!props) return;
    map.getCanvas().style.cursor = "pointer";
    const reasons = props.reasons ? String(props.reasons) : "No elevated risk";
    tip.hidden = false;
    tip.textContent = `${props.mile} · ${props.levelLabel} · ETA ${props.eta}. Wind ${props.wind}, gust ${props.gust}, rain ${props.rain}, snow ${props.snow}, ${props.temp}. ${reasons}`;
    tip.style.transform = `translate(${event.point.x + 14}px, ${event.point.y + 14}px)`;
  });

  map.on("mouseleave", "checkpoint-hit", () => {
    map.getCanvas().style.cursor = "";
    tip.hidden = true;
  });

  const handle: MapHandle = {
    setPlan(next) {
      if (!alive) return;
      plan = next;
      selectedId = next.recommended_route_id;
      if (!styled) return;
      applyPlan();
    },
    setSelected(routeId) {
      if (!alive) return;
      selectedId = routeId;
      if (!styled) return;
      applySelection();
    },
    setHeatmap(data) {
      if (!alive) return;
      heat = data;
      if (!styled) return;
      applyHeat();
    },
    setFrame(nextHour, nextVariable, visible) {
      if (!alive) return;
      hour = nextHour;
      variable = nextVariable;
      heatVisible = visible;
      if (!styled) return;
      applyFrame();
    },
    setBasemap(nextTheme) {
      map.setStyle(STYLES[nextTheme === "dark" ? "dark" : "light"]);
    },
    showCheckpoint(routeId, index) {
      const hit = hits.get(`${routeId}:${index}`);
      options.onInspect(routeId, index);
      if (!hit || !styled) return;
      const camera = { center: [hit.lon, hit.lat] as [number, number], zoom: Math.max(map.getZoom(), 6) };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) map.jumpTo(camera);
      else map.easeTo({ ...camera, duration: 400 });
    },
    destroy() {
      alive = false;
      resize.disconnect();
      for (const marker of markers) marker.remove();
      map.remove();
    },
  };

  return handle;
}
