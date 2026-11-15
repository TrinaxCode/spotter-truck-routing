import type {
  GeocodeResponse,
  GeoPoint,
  HealthResponse,
  HeatmapResponse,
  PlanRequest,
  PlanResponse,
} from "../api/types";
import { ApiError } from "../api/errors";
import { samePoint } from "../lib/geo";
import { toUtcZ } from "../lib/time";
import { RISK_LABELS, assess } from "./assess";
import { rescore } from "./score";
import { warpLngLat, type LatLon } from "./warp";
import heatmapFixture from "./heatmap.json";
import placesFixture from "./places.json";
import plansFixture from "./plans.json";

interface PlansBundle {
  canonical_departure: string;
  load_lbs: number;
  origin: GeoPoint;
  destination: GeoPoint;
  plans: Record<"10" | "25" | "50", PlanResponse>;
}

const bundle = plansFixture as unknown as PlansBundle;
const places = placesFixture as GeoPoint[];
const heatmapBase = heatmapFixture as unknown as HeatmapResponse;

export const CANONICAL_DEPARTURE = bundle.canonical_departure;
export const CANONICAL_LOAD = bundle.load_lbs;
export const CANONICAL_ORIGIN = bundle.origin;
export const CANONICAL_DESTINATION = bundle.destination;

interface MockContext {
  deltaMs: number;
  loadLbs: number;
  origin: GeoPoint;
  destination: GeoPoint;
  planId: string;
}

let lastContext: MockContext = {
  deltaMs: 0,
  loadLbs: CANONICAL_LOAD,
  origin: CANONICAL_ORIGIN,
  destination: CANONICAL_DESTINATION,
  planId: "c0ffee25",
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function shiftIso(iso: string, deltaMs: number): string {
  if (!deltaMs) return iso;
  return toUtcZ(Date.parse(iso) + deltaMs);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function shiftPlan(plan: PlanResponse, deltaMs: number): void {
  if (!deltaMs) return;
  for (const route of plan.routes) {
    route.departure = shiftIso(route.departure, deltaMs);
    route.arrival = shiftIso(route.arrival, deltaMs);
    for (const checkpoint of route.checkpoints) {
      checkpoint.eta = shiftIso(checkpoint.eta, deltaMs);
      if (checkpoint.weather) {
        checkpoint.weather.forecast_time = shiftIso(checkpoint.weather.forecast_time, deltaMs);
      }
    }
    for (const item of route.summary.breaks) {
      item.start = shiftIso(item.start, deltaMs);
      item.end = shiftIso(item.end, deltaMs);
    }
  }
}

function warpPlan(plan: PlanResponse, fromO: LatLon, fromD: LatLon, toO: LatLon, toD: LatLon): void {
  for (const route of plan.routes) {
    route.geometry.coordinates = route.geometry.coordinates.map(([lon, lat]) => {
      const point = warpLngLat(lon, lat, fromO, fromD, toO, toD);
      return [round4(point.lon), round4(point.lat)];
    });
    for (const checkpoint of route.checkpoints) {
      const point = warpLngLat(checkpoint.lon, checkpoint.lat, fromO, fromD, toO, toD);
      checkpoint.lon = round4(point.lon);
      checkpoint.lat = round4(point.lat);
    }
  }
}

function applyLoad(plan: PlanResponse, loadLbs: number): void {
  for (const route of plan.routes) {
    for (const checkpoint of route.checkpoints) {
      if (!checkpoint.weather) continue;
      const assessed = assess(
        checkpoint.weather.wind_mph,
        checkpoint.weather.rain_in_hr,
        checkpoint.weather.snow_in_hr,
        loadLbs,
      );
      checkpoint.level = assessed.level;
      checkpoint.level_label = RISK_LABELS[assessed.level];
      checkpoint.levels = { wind: assessed.wind, rain: assessed.rain, snow: assessed.snow };
      checkpoint.reasons = assessed.reasons;
    }
  }
}

function applyDriveOnly(plan: PlanResponse): void {
  for (const route of plan.routes) {
    route.total_time_s = route.drive_time_s;
    route.arrival = toUtcZ(Date.parse(route.departure) + route.drive_time_s * 1000);
    route.summary.breaks = [];
    for (const checkpoint of route.checkpoints) {
      const fraction = route.distance_mi === 0 ? 0 : checkpoint.mile / route.distance_mi;
      const drive = Math.round(fraction * route.drive_time_s);
      checkpoint.eta = toUtcZ(Date.parse(route.departure) + drive * 1000);
    }
  }
}

function validateRequest(body: PlanRequest): void {
  const fields: Record<string, string> = {};
  const checkPoint = (point: GeoPoint, name: string) => {
    if (point.lat < -90 || point.lat > 90) fields[name] = "Latitude must be between -90 and 90.";
    if (point.lon < -180 || point.lon > 180) fields[name] = "Longitude must be between -180 and 180.";
  };
  checkPoint(body.origin, "origin");
  checkPoint(body.destination, "destination");
  if (samePoint(body.origin, body.destination)) {
    fields.destination = "Origin and destination must be different.";
  }
  if (!Number.isInteger(body.load_lbs) || body.load_lbs < 0 || body.load_lbs > 80_000) {
    fields.load_lbs = "Load must be a whole number from 0 to 80,000.";
  }
  if (body.interval_mi !== 10 && body.interval_mi !== 25 && body.interval_mi !== 50) {
    fields.interval_mi = "Interval must be 10, 25, or 50.";
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiError(400, "validation_error", "Check the trip and try again.", fields);
  }
}

export async function mockHealth(delayMs: number, signal?: AbortSignal): Promise<HealthResponse> {
  await delay(delayMs, signal);
  return { status: "ok" };
}

export async function mockGeocode(
  query: string,
  delayMs: number,
  signal?: AbortSignal,
): Promise<GeocodeResponse> {
  await delay(delayMs, signal);
  const needle = query.trim().toLowerCase();
  if (needle.length < 3) return { results: [] };
  return {
    results: places.filter((place) => place.label.toLowerCase().includes(needle)).slice(0, 6),
  };
}

export async function mockPlan(
  body: PlanRequest,
  delayMs: number,
  signal?: AbortSignal,
): Promise<PlanResponse> {
  await delay(delayMs, signal);
  validateRequest(body);
  const interval = body.interval_mi;
  const plan = structuredClone(bundle.plans[interval]);
  const deltaMs = Date.parse(body.departure) - Date.parse(bundle.canonical_departure);
  shiftPlan(plan, deltaMs);
  const moved = !samePoint(body.origin, bundle.origin) || !samePoint(body.destination, bundle.destination);
  if (moved) warpPlan(plan, bundle.origin, bundle.destination, body.origin, body.destination);
  plan.request = body;
  if (body.load_lbs !== bundle.load_lbs) applyLoad(plan, body.load_lbs);
  if (!body.hos) applyDriveOnly(plan);
  if (body.load_lbs !== bundle.load_lbs || !body.hos) rescore(plan);
  lastContext = {
    deltaMs,
    loadLbs: body.load_lbs,
    origin: body.origin,
    destination: body.destination,
    planId: plan.plan_id,
  };
  return plan;
}

export async function mockHeatmap(
  planId: string,
  delayMs: number,
  signal?: AbortSignal,
): Promise<HeatmapResponse> {
  await delay(delayMs, signal);
  const known = planId === "c0ffee10" || planId === "c0ffee25" || planId === "c0ffee50";
  if (!known || (lastContext.planId !== planId && lastContext.planId !== "c0ffee25" && planId !== lastContext.planId)) {
    if (!known) throw new ApiError(404, "not_found", "Plan not found or expired.");
  }
  if (!known) throw new ApiError(404, "not_found", "Plan not found or expired.");
  const heat = structuredClone(heatmapBase);
  heat.plan_id = planId;
  heat.start = shiftIso(heat.start, lastContext.deltaMs);
  heat.load_lbs = lastContext.loadLbs;
  const moved =
    !samePoint(lastContext.origin, bundle.origin) || !samePoint(lastContext.destination, bundle.destination);
  if (moved) {
    heat.cells = heat.cells.map((cell) => {
      const point = warpLngLat(
        cell.lon,
        cell.lat,
        bundle.origin,
        bundle.destination,
        lastContext.origin,
        lastContext.destination,
      );
      return { lat: round4(point.lat), lon: round4(point.lon) };
    });
  }
  if (lastContext.loadLbs !== bundle.load_lbs) {
    heat.risk = heat.wind.map((windRow, index) =>
      windRow.map((wind, hour) => {
        const rain = heat.rain[index]?.[hour];
        const snow = heat.snow[index]?.[hour];
        if (wind == null || rain == null || snow == null) return null;
        return assess(wind, rain, snow, lastContext.loadLbs).level;
      }),
    );
  }
  return heat;
}
