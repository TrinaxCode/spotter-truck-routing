import * as maplibregl from "maplibre-gl";
import type { AllPaintProperties, FilterSpecification, GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

maplibregl.setWorkerUrl(workerUrl);
import type { HeatmapResponse, HeatVariable, PlanResponse } from "../api/types";
import { corridorFeatures, heatmapFillColor, heatmapFillOpacity, type PaintExpr } from "../lib/heatmap";
import { formatInchesPerHour, formatMiles, formatShortClock, formatSpeedMph, formatTempF } from "../lib/format";
import { NEUTRAL_ROUTE_COLOR, riskColor } from "../lib/riskColor";
import { segmentRoute } from "../lib/routeSegments";
import { etaHourIndex, floorHourIso } from "../lib/time";
import type { MapHandle, TruckPosition } from "./handle";
import type { Truck3D } from "./truck3d";

export type { MapHandle } from "./handle";

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

type Theme = keyof typeof STYLES;

/** Half of a 44 px map pin plus a gap. */
const PIN_CLEARANCE_PX = 40;
/**
 * The attribution control is empty until credits load, after the first fit, so its band
 * (a 44 px target on mobile, a 24 px bar plus margins on desktop) is reserved up front.
 */
const ATTRIBUTION_BAND_PX = 48;
/** The fit never squeezes the routes into less than this much map on either axis. */
const MIN_VISIBLE_PX = 160;
const MOBILE_QUERY = "(max-width: 767px)";
const FADE_MS = 450;
/** The light basemap washes colour out less, so the same fill needs a touch less opacity. */
const HEAT_GAIN: Record<Theme, number> = { light: 0.85, dark: 1 };
const ACCENT: Record<Theme, string> = { light: "#1d5cf0", dark: "#5b9dff" };
/** Dark ring under every risk colour keeps each one at >= 3:1 on both basemaps. */
const CASING = "#0a0f1a";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const ROUTE_SOURCE = "routes";
const SEGMENT_SOURCE = "segments";
const CHECKPOINT_SOURCE = "checkpoints";
const CORRIDOR_SOURCE = "corridor";
/** One feature, rewritten every animation frame during trip playback. The only source that is. */
const TRUCK_SOURCE = "truck";
const TRUCK_ICON = "truck-arrow";
/** Checkpoint ids are unique across routes so feature-state can address one of them. */
const FEATURE_STRIDE = 100_000;

/** Width in px at low and high zoom; MapLibre interpolates between them. */
function zoomWidth(low: number, high: number): PaintExpr {
  return ["interpolate", ["linear"], ["zoom"], 3, low, 8, high, 12, high * 1.4];
}

export interface MapControllerOptions {
  theme: Theme;
  onReady: (handle: MapHandle) => void;
  onInspect: (routeId: string, index: number) => void;
  onSelect: (routeId: string) => void;
  /** The basemap style could not be loaded (network, blocked host). The map surface is unusable. */
  onStyleError: (message: string) => void;
  /** The chase camera started or stopped (also when the user drags the map away). */
  onChaseChange?: (following: boolean) => void;
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
    truckUpdates: 0,
    featureStateUpdates: 0,
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

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createMapController(container: HTMLElement, options: MapControllerOptions): MapHandle {
  let theme: Theme = options.theme === "dark" ? "dark" : "light";
  const map = new maplibregl.Map({
    container,
    style: STYLES[theme],
    center: [-100.4, 36.4],
    zoom: 4.1,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: 0,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");
  // Phones keep the credits bottom-left, away from the zoom buttons, because the sheet leaves little map.
  const phone = window.matchMedia(MOBILE_QUERY).matches;
  map.addControl(new maplibregl.AttributionControl({ compact: true }), phone ? "bottom-left" : "bottom-right");
  map.touchZoomRotate.disableRotation();
  // MapLibre opens the compact attribution (compact-show) the first time credits
  // arrive, which covers the route on a short map. Collapse it once, after that.
  const collapseAttrib = () => {
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

  const tip = element("div", "map-tip");
  tip.hidden = true;
  tip.setAttribute("aria-hidden", "true");
  container.append(tip);

  let alive = true;
  let styled = false;
  /** True from creation (and from each basemap switch) until `style.load`. */
  let loadingStyle = true;
  let styleFailed = false;
  let booted = false;
  let plan: PlanResponse | null = null;
  let autoFramed: PlanResponse | null = null;
  let heat: HeatmapResponse | null = null;
  let selectedId = "";
  let hoverId = "";
  let hour = 0;
  let variable: HeatVariable = "risk";
  let heatVisible = true;
  /** 0..1 multiplier on the corridor opacity; eased for the fade-in, constant while sliding. */
  let gain = 0;
  let fadeFrame = 0;
  let fadeTarget = 0;
  const markers: maplibregl.Marker[] = [];
  const hits = new Map<string, CheckpointHit>();
  const featureIds = new Map<string, number>();
  let focusedId: number | null = null;
  let focusKey = "";
  let truck: TruckPosition | null = null;
  /** three.js truck, loaded on the first playback frame (its chunk stays out of the shell). */
  let truck3d: Truck3D | null = null;
  let truck3dLoading = false;
  /** Chase camera: tilted, centred on the truck and turned with its heading while it drives. */
  let chase = false;
  let chaseEntering = false;
  let chaseBearing = 0;
  let followPadding: maplibregl.PaddingOptions | null = null;
  let followPaddingAt = 0;
  let lastFollowAt = 0;

  const overlayNodes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-map-overlay]")];

  let layoutFrame = 0;
  const onLayout = () => {
    if (!alive || layoutFrame) return;
    // Overlays resize in bursts (sheet snaps, font swap, list growth); settle once per frame.
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!alive) return;
      map.resize();
      publishInsets();
      refit();
    });
  };
  const resize = new ResizeObserver(onLayout);
  resize.observe(container);
  const watched = new WeakSet<Element>();
  const watchOverlays = () => {
    for (const node of overlayNodes()) {
      if (watched.has(node)) continue;
      watched.add(node);
      resize.observe(node);
    }
  };
  watchOverlays();
  // Floating cards mount later (the drive call to action, the trip HUD); frame around them too.
  const overlayMounts = new MutationObserver(() => {
    watchOverlays();
    onLayout();
  });
  overlayMounts.observe(document.body, { childList: true, subtree: true });
  // A gesture hands the camera to the user; programmatic moves carry no originalEvent.
  map.on("movestart", (event) => {
    if (!event.originalEvent) return;
    autoFramed = null;
    // Dragging the map during playback hands the camera back to the user.
    if (chase) setChaseState(false);
  });

  // The OpenFreeMap dark style references a POI sprite it does not ship; a blank pixel keeps the console clean.
  map.setMissingStyleImageResolver((id) => {
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    return Promise.resolve();
  });

  map.on("error", (event) => {
    const message = event.error?.message ?? "";
    // Before the style is in, no source or layer exists, so an error is the style itself failing
    // (sprite and glyph fetches are the exception: the map still works without them). After the
    // style loads, tile, sprite and glyph errors are isolated and the map keeps working.
    const ancillary = /sprite|glyph|font/i.test(`${message} ${(event.error as { url?: string } | undefined)?.url ?? ""}`);
    if (loadingStyle && !styleFailed && alive && !ancillary) {
      styleFailed = true;
      options.onStyleError(message || "The basemap style did not load.");
      return;
    }
    if (/ajax|tile|sprite|glyph|fetch|Failed to load/i.test(message)) return;
    console.warn(message);
  });

  function bumpSource(): void {
    if (import.meta.env.DEV) ensureProbe().sourceUpdates += 1;
  }

  function bumpTruck(): void {
    if (import.meta.env.DEV) ensureProbe().truckUpdates += 1;
  }

  function bumpFeatureState(): void {
    if (import.meta.env.DEV) ensureProbe().featureStateUpdates += 1;
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
    for (const id of [CORRIDOR_SOURCE, ROUTE_SOURCE, SEGMENT_SOURCE, CHECKPOINT_SOURCE, TRUCK_SOURCE]) {
      if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY });
    }

    // Heatmap, then routes, all under the basemap labels; only checkpoints sit above them.
    const anchor = labelAnchor();
    const lineLayout = { "line-cap": "round" as const, "line-join": "round" as const };
    const neutral = NEUTRAL_ROUTE_COLOR[theme];
    const neutralCasing = theme === "dark" ? CASING : "#ffffff";
    addLayer(
      {
        id: "corridor",
        type: "fill",
        source: CORRIDOR_SOURCE,
        paint: {
          "fill-color": "rgba(0,0,0,0)",
          "fill-opacity": 0,
          "fill-antialias": false,
        },
      },
      anchor,
    );
    addLayer(
      {
        id: "routes-other-casing",
        type: "line",
        source: ROUTE_SOURCE,
        paint: {
          "line-color": neutralCasing,
          "line-width": zoomWidth(3.5, 6) as AllPaintProperties["line-width"],
          "line-opacity": 0.55,
        },
        layout: lineLayout,
      },
      anchor,
    );
    addLayer(
      {
        id: "routes-other",
        type: "line",
        source: ROUTE_SOURCE,
        paint: {
          "line-color": neutral,
          "line-width": zoomWidth(1.6, 3) as AllPaintProperties["line-width"],
          "line-opacity": 0.85,
        },
        layout: lineLayout,
      },
      anchor,
    );
    // A wide, invisible twin of the quiet routes: thin lines are hard to hit with a finger.
    addLayer(
      {
        id: "routes-other-hit",
        type: "line",
        source: ROUTE_SOURCE,
        paint: { "line-color": CASING, "line-width": 20, "line-opacity": 0.01 },
        layout: lineLayout,
      },
      anchor,
    );
    addLayer(
      {
        id: "route-hover",
        type: "line",
        source: ROUTE_SOURCE,
        paint: {
          "line-color": ACCENT[theme],
          "line-width": zoomWidth(3.5, 6) as AllPaintProperties["line-width"],
          "line-opacity": 0.95,
        },
        layout: lineLayout,
        filter: ["==", ["get", "routeId"], ""],
      },
      anchor,
    );
    addLayer(
      {
        id: "route-casing",
        type: "line",
        source: ROUTE_SOURCE,
        paint: {
          "line-color": CASING,
          "line-width": zoomWidth(8, 13) as AllPaintProperties["line-width"],
          "line-opacity": 0.92,
        },
        layout: lineLayout,
      },
      anchor,
    );
    addLayer(
      {
        id: "route-selected",
        type: "line",
        source: SEGMENT_SOURCE,
        paint: {
          "line-color": ["coalesce", ["get", "color"], NEUTRAL_ROUTE_COLOR[theme]],
          "line-width": zoomWidth(4.5, 8) as AllPaintProperties["line-width"],
          "line-opacity": 1,
        },
        layout: lineLayout,
      },
      anchor,
    );
    // No Travel is also marked by pattern, never by colour alone.
    addLayer(
      {
        id: "route-halt",
        type: "line",
        source: SEGMENT_SOURCE,
        paint: {
          "line-color": "#ffffff",
          "line-width": zoomWidth(1.4, 2.4) as AllPaintProperties["line-width"],
          "line-opacity": 0.95,
          "line-dasharray": [0.8, 1.6],
        },
        layout: { "line-cap": "butt", "line-join": "round" },
        filter: ["==", ["get", "level"], 4],
      },
      anchor,
    );
    addLayer({
      id: "checkpoints",
      type: "circle",
      source: CHECKPOINT_SOURCE,
      paint: {
        "circle-color": ["coalesce", ["get", "color"], "#7c8794"],
        "circle-radius": 4,
        "circle-stroke-color": theme === "dark" ? CASING : "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": 1,
        "circle-pitch-alignment": "map",
      },
    });
    addLayer({
      id: "checkpoint-hit",
      type: "circle",
      source: CHECKPOINT_SOURCE,
      paint: {
        "circle-color": CASING,
        "circle-radius": 18,
        "circle-opacity": 0.01,
        "circle-stroke-width": 0,
      },
    });
    // The weather profile's cursor: a ring under the checkpoint dot, driven by feature-state alone.
    const focused: PaintExpr = ["boolean", ["feature-state", "focus"], false];
    addLayer(
      {
        id: "checkpoint-focus",
        type: "circle",
        source: CHECKPOINT_SOURCE,
        paint: {
          "circle-color": ACCENT[theme],
          "circle-radius": 14,
          "circle-opacity": ["case", focused, 0.3, 0] as unknown as AllPaintProperties["circle-opacity"],
          "circle-stroke-color": ACCENT[theme],
          "circle-stroke-width": 2.5,
          "circle-stroke-opacity": ["case", focused, 1, 0] as unknown as AllPaintProperties["circle-stroke-opacity"],
          "circle-pitch-alignment": "map",
        },
      },
      "checkpoints",
    );
    installTruck();
  }

  /** Chevron for the truck, drawn once per style (a style swap drops added images). */
  function installTruck(): void {
    if (!map.hasImage(TRUCK_ICON)) {
      const size = 48;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(size / 2, 8);
        ctx.lineTo(size - 11, size - 11);
        ctx.lineTo(size / 2, size - 19);
        ctx.lineTo(11, size - 11);
        ctx.closePath();
        ctx.fill();
        map.addImage(TRUCK_ICON, ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
      }
    }
    addLayer({
      id: "truck-halo",
      type: "circle",
      source: TRUCK_SOURCE,
      paint: {
        "circle-radius": 19,
        "circle-color": ["case", ["==", ["get", "stopped"], true], "#f6c928", ACCENT[theme]] as unknown as AllPaintProperties["circle-color"],
        "circle-opacity": 0.28,
        "circle-pitch-alignment": "map",
      },
    });
    addLayer({
      id: "truck-body",
      type: "circle",
      source: TRUCK_SOURCE,
      paint: {
        "circle-radius": 11,
        "circle-color": ["case", ["==", ["get", "stopped"], true], "#f6c928", ACCENT[theme]] as unknown as AllPaintProperties["circle-color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3,
        "circle-pitch-alignment": "map",
      },
    });
    addLayer({
      id: "truck-arrow",
      type: "symbol",
      source: TRUCK_SOURCE,
      layout: {
        "icon-image": TRUCK_ICON,
        "icon-size": 0.62,
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-opacity": ["case", ["==", ["get", "stopped"], true], 0, 1] as unknown as AllPaintProperties["icon-opacity"] },
    });
    if (truck3d) mountTruck3D();
  }

  const TRUCK_2D_LAYERS = ["truck-halo", "truck-body", "truck-arrow"];

  /** Adds the three.js truck above everything and retires the flat chevron. */
  function mountTruck3D(): void {
    if (!truck3d || !styled) return;
    truck3d.setAccent(ACCENT[theme]);
    if (!map.getLayer(truck3d.layer.id)) map.addLayer(truck3d.layer);
    if (import.meta.env.DEV) ensureProbe().truck3d = true;
    for (const id of TRUCK_2D_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    }
    truck3d.update(truck);
  }

  function loadTruck3D(): void {
    if (truck3d || truck3dLoading) return;
    truck3dLoading = true;
    import("./truck3d")
      .then(({ createTruck3D }) => {
        if (!alive) return;
        truck3d = createTruck3D(map, ACCENT[theme]);
        mountTruck3D();
      })
      .catch((error: unknown) => {
        // The flat chevron keeps working; a failed chunk only costs the 3D look.
        console.warn("3D truck unavailable", error);
      })
      .finally(() => {
        truck3dLoading = false;
      });
  }

  /** Shortest-path easing between two compass bearings. */
  function easeBearing(from: number, to: number, k: number): number {
    const delta = ((((to - from) % 360) + 540) % 360) - 180;
    return from + delta * k;
  }

  /** Tilts in behind the truck once, then tracks it every frame with a damped heading. */
  function followTruck(): void {
    if (!truck || !chase || chaseEntering) return;
    chaseBearing = easeBearing(chaseBearing, truck.bearing, truck.stopped ? 0 : 0.06);
    map.jumpTo({ center: [truck.lon, truck.lat], bearing: chaseBearing, padding: followPadding ?? overlayPadding() });
  }

  function setChaseState(on: boolean): void {
    chase = on;
    if (import.meta.env.DEV) ensureProbe().chase = on;
    options.onChaseChange?.(on);
  }

  function enterChase(): void {
    if (!truck || !styled) return;
    setChaseState(true);
    chaseEntering = true;
    autoFramed = null;
    followPadding = overlayPadding();
    followPaddingAt = performance.now();
    chaseBearing = truck.bearing;
    map.easeTo({
      center: [truck.lon, truck.lat],
      zoom: Math.max(map.getZoom(), 10.2),
      pitch: 60,
      bearing: chaseBearing,
      padding: followPadding,
      duration: 1400,
      essential: true,
    });
    map.once("moveend", () => {
      chaseEntering = false;
    });
  }

  /** Back to the flat overview of the whole trip. */
  function leaveChase(): void {
    const was = chase || map.getPitch() > 0 || map.getBearing() !== 0;
    chaseEntering = false;
    setChaseState(false);
    if (!was || !plan || !styled) return;
    map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    map.once("moveend", () => {
      if (alive && plan && !chase) fit(plan);
    });
  }

  /**
   * Checkpoints whose weather comes from the slider frame, per variable: nearest hour for Wind,
   * the hour closing the ETA for Rain, Snow and Risk (see etaHourIndex). The layer filter already
   * limits this to the selected route. Only the paint expression changes with the frame.
   */
  function inSelectedHour(): PaintExpr {
    return ["==", ["get", variable === "wind" ? "hourWind" : "hourPrecip"], hour];
  }

  function paintCheckpoints(): void {
    const active = inSelectedHour();
    const radius = (calm: number, loud: number): PaintExpr => [
      "case",
      active,
      loud,
      calm,
    ];
    paint(
      "checkpoints",
      "circle-radius",
      [
        "interpolate",
        ["linear"],
        ["zoom"],
        3,
        radius(2.5, 6),
        7,
        radius(5, 10),
        11,
        radius(8, 14),
      ] as unknown as AllPaintProperties["circle-radius"],
    );
    paint(
      "checkpoints",
      "circle-stroke-width",
      ["case", active, 3.5, 1.5] as unknown as AllPaintProperties["circle-stroke-width"],
    );
    paint(
      "checkpoints",
      "circle-stroke-color",
      ["case", active, ACCENT[theme], theme === "dark" ? CASING : "#ffffff"] as unknown as AllPaintProperties["circle-stroke-color"],
    );
  }

  function applyHover(): void {
    if (!map.getLayer("route-hover")) return;
    const active = hoverId && hoverId !== selectedId ? hoverId : "";
    map.setFilter("route-hover", ["==", ["get", "routeId"], active]);
  }

  function applySelection(): void {
    const other: FilterSpecification = ["!=", ["get", "routeId"], selectedId];
    const selected: FilterSpecification = ["==", ["get", "routeId"], selectedId];
    for (const id of ["routes-other", "routes-other-casing", "routes-other-hit"]) {
      if (map.getLayer(id)) map.setFilter(id, other);
    }
    for (const id of ["route-selected", "route-casing"]) {
      if (map.getLayer(id)) map.setFilter(id, selected);
    }
    if (map.getLayer("route-halt")) {
      map.setFilter("route-halt", ["all", selected, ["==", ["get", "level"], 4]]);
    }
    // Only the selected route shows checkpoints; the others stay quiet until picked.
    for (const id of ["checkpoints", "checkpoint-hit", "checkpoint-focus"]) {
      if (map.getLayer(id)) map.setFilter(id, selected);
    }
    applyHover();
    paintCheckpoints();
  }

  function desiredGain(): number {
    return heatVisible && heat != null ? HEAT_GAIN[theme] : 0;
  }

  function applyOpacity(): void {
    // Visibility is carried by `gain`, so hiding the heatmap fades instead of cutting.
    const opacity = heatmapFillOpacity(variable, hour, heat != null, gain);
    paint("corridor", "fill-opacity", opacity as AllPaintProperties["fill-opacity"]);
  }

  /** Eases the corridor opacity to its target. Reduced motion jumps. Never runs while sliding. */
  function easeGain(target: number): void {
    cancelAnimationFrame(fadeFrame);
    fadeFrame = 0;
    fadeTarget = target;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || Math.abs(target - gain) < 0.001) {
      gain = target;
      applyOpacity();
      return;
    }
    const from = gain;
    const started = performance.now();
    const step = (now: number) => {
      if (!alive) return;
      const t = Math.min(1, (now - started) / FADE_MS);
      const eased = 1 - (1 - t) ** 3;
      gain = from + (target - from) * eased;
      applyOpacity();
      fadeFrame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    fadeFrame = requestAnimationFrame(step);
  }

  function applyFrame(): void {
    paintExpr("corridor", "fill-color", heatmapFillColor(variable, hour));
    const target = desiredGain();
    if (fadeFrame !== 0 && target === fadeTarget) {
      // A fade toward this target is running and repaints the opacity every frame.
    } else if (Math.abs(target - gain) > 0.001) {
      easeGain(target);
    } else {
      applyOpacity();
    }
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

  /** Heatmap frame 0: the forecast's own start, or the departure hour (floored) until it loads. */
  function frameStart(): string | null {
    if (heat) return heat.start;
    const departure = plan?.routes[0]?.departure;
    return departure ? floorHourIso(departure) : null;
  }

  function checkpointCollection(next: PlanResponse, startIso: string | null): GeoJSON.FeatureCollection {
    hits.clear();
    featureIds.clear();
    const features: GeoJSON.Feature[] = [];
    for (const [routeIndex, route] of next.routes.entries()) {
      for (const checkpoint of route.checkpoints) {
        const key = `${route.id}:${checkpoint.index}`;
        featureIds.set(key, routeIndex * FEATURE_STRIDE + checkpoint.index);
        hits.set(key, {
          routeId: route.id,
          index: checkpoint.index,
          lon: checkpoint.lon,
          lat: checkpoint.lat,
        });
        const weather = checkpoint.weather;
        features.push({
          type: "Feature",
          id: routeIndex * FEATURE_STRIDE + checkpoint.index,
          properties: {
            routeId: route.id,
            index: checkpoint.index,
            // The frame each variable reads this checkpoint from; see etaHourIndex.
            hourWind: startIso ? etaHourIndex(startIso, checkpoint.eta, "wind") : -1,
            hourPrecip: startIso ? etaHourIndex(startIso, checkpoint.eta, "rain") : -1,
            color: riskColor(checkpoint.level),
            level: checkpoint.level ?? -1,
            mile: formatMiles(checkpoint.mile),
            eta: formatShortClock(checkpoint.eta),
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
    const pins: { kind: "start" | "end"; label: string; lon: number; lat: number }[] = [
      { kind: "start", label: next.request.origin.label, lon: next.request.origin.lon, lat: next.request.origin.lat },
      {
        kind: "end",
        label: next.request.destination.label,
        lon: next.request.destination.lon,
        lat: next.request.destination.lat,
      },
    ];
    for (const pin of pins) {
      // A 44 px target around a 20 px mark: touch-sized without a heavy marker.
      const button = element("button", `map-pin map-pin-${pin.kind}`);
      button.type = "button";
      button.append(element("span", "pin-mark"));
      button.setAttribute("aria-label", `${pin.kind === "start" ? "Origin" : "Destination"}, ${pin.label}`);
      const marker = new maplibregl.Marker({ element: button, anchor: "center" })
        .setLngLat([pin.lon, pin.lat])
        .addTo(map);
      markers.push(marker);
    }
  }

  type Edge = "top" | "right" | "bottom" | "left";

  /** Where an overlay docks. The trip panel is a side card on desktop and a bottom sheet on phones. */
  function overlayEdge(node: HTMLElement): Edge | null {
    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    const edge = (mobile ? node.dataset.overlayEdgeMobile : undefined) ?? node.dataset.overlayEdge;
    return edge === "top" || edge === "right" || edge === "bottom" || edge === "left" ? edge : null;
  }

  interface Placed {
    edge: Edge;
    box: DOMRect;
  }

  function placedOverlays(): Placed[] {
    const placed: Placed[] = [];
    for (const node of overlayNodes()) {
      const edge = overlayEdge(node);
      const box = node.getBoundingClientRect();
      if (edge && box.width > 0 && box.height > 0) placed.push({ edge, box });
    }
    // MapLibre's own controls: zoom at top right, attribution at bottom right.
    for (const [selector, edge] of [
      [".maplibregl-ctrl-top-right", "right"],
      [".maplibregl-ctrl-bottom-right", "bottom"],
      [".maplibregl-ctrl-bottom-left", "bottom"],
    ] as const) {
      for (const node of container.querySelectorAll(selector)) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) placed.push({ edge, box });
      }
    }
    return placed;
  }

  /** Lifts the attribution above any docked card it would otherwise sit under. */
  function publishInsets(): void {
    const area = container.getBoundingClientRect();
    let right = 0;
    let left = 0;
    for (const node of overlayNodes()) {
      if (overlayEdge(node) !== "bottom") continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // Only cards that reach a bottom corner (the credits open about 340 px wide) can cover the attribution.
      const lift = area.bottom - box.top;
      if (box.right >= area.right - 340) right = Math.max(right, lift);
      if (box.left <= area.left + 340) left = Math.max(left, lift);
    }
    container.style.setProperty("--inset-bottom-right", `${Math.round(right)}px`);
    container.style.setProperty("--inset-bottom-left", `${Math.round(left)}px`);
  }

  /**
   * Padding that keeps the 44 px Start/End pins (and the route) clear of everything laid over
   * the map: the trip panel, the timeline, the legend and MapLibre's zoom/attribution controls.
   * Measured, because the panels resize with content and every breakpoint lays them out differently.
   */
  function overlayPadding(): maplibregl.PaddingOptions {
    const area = container.getBoundingClientRect();
    const padding = {
      top: PIN_CLEARANCE_PX,
      right: PIN_CLEARANCE_PX,
      bottom: ATTRIBUTION_BAND_PX + PIN_CLEARANCE_PX,
      left: PIN_CLEARANCE_PX,
    };
    for (const { edge, box } of placedOverlays()) {
      if (edge === "top") padding.top = Math.max(padding.top, box.bottom - area.top + PIN_CLEARANCE_PX);
      else if (edge === "bottom") padding.bottom = Math.max(padding.bottom, area.bottom - box.top + PIN_CLEARANCE_PX);
      else if (edge === "left") padding.left = Math.max(padding.left, box.right - area.left + PIN_CLEARANCE_PX);
      else padding.right = Math.max(padding.right, area.right - box.left + PIN_CLEARANCE_PX);
    }
    // Never ask for more padding than the map can give; keep a strip the routes can fill.
    const room = (size: number, a: number, b: number): [number, number] => {
      const free = Math.max(0, size - MIN_VISIBLE_PX);
      if (a + b <= free || a + b === 0) return [a, b];
      const k = free / (a + b);
      return [a * k, b * k];
    };
    [padding.left, padding.right] = room(area.width, padding.left, padding.right);
    [padding.top, padding.bottom] = room(area.height, padding.top, padding.bottom);
    return padding;
  }

  /** Frames the routes; `plan` stays "auto-framed" until the user (or a checkpoint jump) moves the map. */
  function fit(next: PlanResponse, animate = true): void {
    const bounds = new maplibregl.LngLatBounds();
    for (const route of next.routes) {
      for (const coord of route.geometry.coordinates) bounds.extend(coord);
    }
    if (bounds.isEmpty()) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    autoFramed = next;
    // The ResizeObserver is async; frame against the box the padding was just measured in.
    map.resize();
    publishInsets();
    map.fitBounds(bounds, { padding: overlayPadding(), duration: animate && !reduce ? 500 : 0, maxZoom: 8 });
  }

  /** Panels wrap and resize once the web font arrives or the sheet changes snap. */
  function refit(): void {
    if (alive && styled && plan && autoFramed === plan) fit(plan, false);
  }

  function applyPlan(): void {
    if (!plan || !styled) return;
    writeSource(ROUTE_SOURCE, routeCollection(plan));
    writeSource(SEGMENT_SOURCE, segmentCollection(plan));
    writeSource(CHECKPOINT_SOURCE, checkpointCollection(plan, frameStart()));
    syncMarkers(plan);
    applySelection();
    fit(plan);
  }

  function applyHeat(): void {
    if (!styled) return;
    writeSource(CORRIDOR_SOURCE, heat ? corridorFeatures(heat) : EMPTY);
    if (plan) {
      writeSource(CHECKPOINT_SOURCE, checkpointCollection(plan, frameStart()));
    }
    // New data fades in from clear instead of popping on.
    gain = 0;
    applyFrame();
  }

  function truckCollection(): GeoJSON.FeatureCollection {
    if (!truck) return EMPTY;
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { bearing: truck.bearing, stopped: truck.stopped },
          geometry: { type: "Point", coordinates: [truck.lon, truck.lat] },
        },
      ],
    };
  }

  function applyFocus(): void {
    if (focusedId == null || !map.getSource(CHECKPOINT_SOURCE)) return;
    map.setFeatureState({ source: CHECKPOINT_SOURCE, id: focusedId }, { focus: true });
  }

  function clearFocus(): void {
    if (focusedId != null && map.getSource(CHECKPOINT_SOURCE)) {
      map.removeFeatureState({ source: CHECKPOINT_SOURCE, id: focusedId }, "focus");
    }
    focusedId = null;
    focusKey = "";
  }

  /** Brings the camera to a truck that has left the visible part of the map, at most twice a second. */
  function keepTruckInView(): void {
    if (!truck || map.isMoving()) return;
    const now = performance.now();
    if (now - lastFollowAt < 600) return;
    if (!followPadding || now - followPaddingAt > 500) {
      followPadding = overlayPadding();
      followPaddingAt = now;
    }
    const size = map.getContainer().getBoundingClientRect();
    const at = map.project([truck.lon, truck.lat]);
    const margin = 24;
    const inside =
      at.x >= followPadding.left! + margin &&
      at.x <= size.width - followPadding.right! - margin &&
      at.y >= followPadding.top! + margin &&
      at.y <= size.height - followPadding.bottom! - margin;
    if (inside) return;
    lastFollowAt = now;
    autoFramed = null;
    const camera = { center: [truck.lon, truck.lat] as [number, number], padding: followPadding };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: 500 });
  }

  function restore(): void {
    installLayers();
    if (plan) {
      writeSource(ROUTE_SOURCE, routeCollection(plan));
      writeSource(SEGMENT_SOURCE, segmentCollection(plan));
      writeSource(CHECKPOINT_SOURCE, checkpointCollection(plan, frameStart()));
      syncMarkers(plan);
      applySelection();
    }
    if (heat) {
      writeSource(CORRIDOR_SOURCE, corridorFeatures(heat));
    }
    if (truck) geoSource(TRUCK_SOURCE)?.setData(truckCollection());
    applyFocus();
    // A theme change redraws a finished corridor; it does not replay the fade.
    cancelAnimationFrame(fadeFrame);
    fadeFrame = 0;
    gain = desiredGain();
    applyFrame();
  }

  map.on("style.load", () => {
    if (!alive) return;
    styled = true;
    loadingStyle = false;
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

  for (const layerId of ["routes-other-hit", "routes-other", "route-selected", "route-casing"]) {
    map.on("click", layerId, selectRoute);
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  // Pointing at a quiet route lights it up, the same highlight a hovered card gives.
  map.on("mousemove", "routes-other-hit", (event) => {
    const routeId = event.features?.[0]?.properties?.routeId;
    if (typeof routeId === "string" && routeId !== hoverId) {
      hoverId = routeId;
      applyHover();
    }
  });
  map.on("mouseleave", "routes-other-hit", () => {
    hoverId = "";
    applyHover();
  });

  map.on("click", "checkpoint-hit", (event) => {
    const feature = event.features?.[0];
    const routeId = feature?.properties?.routeId;
    const index = feature?.properties?.index;
    if (typeof routeId === "string" && index != null) options.onInspect(routeId, Number(index));
  });

  function fillTip(props: Record<string, unknown>): void {
    const level = Number(props.level);
    const head = element("div", "tip-head");
    const dot = element("span", "tip-dot");
    dot.style.background = String(props.color ?? "#7c8794");
    head.append(dot, element("strong", "", String(props.mile)), element("span", "tip-level", String(props.levelLabel)));
    const eta = element("div", "tip-eta", `ETA ${props.eta}`);
    const wx = element(
      "div",
      "tip-wx",
      `Wind ${props.wind} · Gust ${props.gust} · Rain ${props.rain} · Snow ${props.snow} · ${props.temp}`,
    );
    tip.replaceChildren(head, eta, wx);
    if (props.reasons && level > 0) tip.append(element("div", "tip-why", String(props.reasons)));
  }

  map.on("mousemove", "checkpoint-hit", (event) => {
    const props = event.features?.[0]?.properties;
    if (!props) return;
    map.getCanvas().style.cursor = "pointer";
    fillTip(props);
    tip.hidden = false;
    // Keep the card inside the map: flip to the left/top of the pointer near the far edges.
    const area = container.getBoundingClientRect();
    const flipX = event.point.x + 16 + tip.offsetWidth > area.width;
    const flipY = event.point.y + 16 + tip.offsetHeight > area.height;
    const x = flipX ? event.point.x - 16 - tip.offsetWidth : event.point.x + 16;
    const y = flipY ? event.point.y - 16 - tip.offsetHeight : event.point.y + 16;
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
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
      hoverId = "";
      // Ids are per plan; a ring or truck from the previous trip does not carry over.
      if (styled) clearFocus();
      else {
        focusedId = null;
        focusKey = "";
      }
      truck = null;
      // The previous corridor belongs to the previous trip; drop it until the new one arrives.
      const stale = heat !== null;
      heat = null;
      if (!styled) return;
      applyPlan();
      geoSource(TRUCK_SOURCE)?.setData(EMPTY);
      if (stale) {
        writeSource(CORRIDOR_SOURCE, EMPTY);
        cancelAnimationFrame(fadeFrame);
        fadeFrame = 0;
        gain = 0;
        applyFrame();
      }
    },
    setSelected(routeId) {
      if (!alive) return;
      selectedId = routeId;
      if (!styled) return;
      applySelection();
    },
    setHover(routeId) {
      if (!alive) return;
      hoverId = routeId ?? "";
      if (styled) applyHover();
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
      theme = nextTheme === "dark" ? "dark" : "light";
      loadingStyle = true;
      map.setStyle(STYLES[theme]);
    },
    showCheckpoint(routeId, index) {
      const hit = hits.get(`${routeId}:${index}`);
      options.onInspect(routeId, index);
      if (!hit || !styled) return;
      autoFramed = null;
      // Centre in the part of the map no panel covers.
      const camera = {
        center: [hit.lon, hit.lat] as [number, number],
        zoom: Math.max(map.getZoom(), 6),
        padding: overlayPadding(),
      };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) map.jumpTo(camera);
      else map.easeTo({ ...camera, duration: 400 });
    },
    setFocus(routeId, index) {
      if (!alive) return;
      const key = routeId == null || index == null ? "" : `${routeId}:${index}`;
      if (key === focusKey) return;
      if (styled) clearFocus();
      focusKey = key;
      focusedId = key ? (featureIds.get(key) ?? null) : null;
      if (styled) {
        applyFocus();
        bumpFeatureState();
      }
    },
    setTruck(next) {
      if (!alive) return;
      const starting = !truck && next;
      truck = next;
      if (!styled) return;
      geoSource(TRUCK_SOURCE)?.setData(truckCollection());
      truck3d?.update(next);
      bumpTruck();
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!next) {
        leaveChase();
        return;
      }
      if (!reduce) loadTruck3D();
      if (starting && !reduce) enterChase();
      if (chase) followTruck();
      else keepTruckInView();
    },
    setChase(on) {
      if (!alive || !truck) return;
      if (on && !chase) enterChase();
      else if (!on && chase) leaveChase();
    },
    destroy() {
      alive = false;
      cancelAnimationFrame(fadeFrame);
      cancelAnimationFrame(layoutFrame);
      resize.disconnect();
      overlayMounts.disconnect();
      tip.remove();
      for (const marker of markers) marker.remove();
      map.remove();
    },
  };

  return handle;
}
