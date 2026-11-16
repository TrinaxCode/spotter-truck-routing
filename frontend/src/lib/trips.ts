import type { GeoPoint } from "../api/types";
import type { TripDraft } from "./form";
import { formatLoadLbs, parseLoadLbs } from "./format";
import { nextFullHourInput } from "./time";

/** A trip without its departure: examples, recent trips and shared links all start from this. */
export interface TripTemplate {
  origin: GeoPoint;
  destination: GeoPoint;
  loadLbs: number;
  interval: TripDraft["interval"];
  hos: boolean;
}

/** One-click starters that show off different weather regimes across the US. */
export const EXAMPLE_TRIPS: { title: string; note: string; trip: TripTemplate }[] = [
  {
    title: "Dallas → Denver",
    note: "Plains wind corridor",
    trip: {
      origin: { lat: 32.7767, lon: -96.797, label: "Dallas, TX, USA" },
      destination: { lat: 39.7392, lon: -104.9903, label: "Denver, CO, USA" },
      loadLbs: 35_000,
      interval: 25,
      hos: true,
    },
  },
  {
    title: "Oakland → Reno",
    note: "Sierra pass, heavy load",
    trip: {
      origin: { lat: 37.8044, lon: -122.2712, label: "Oakland, CA, USA" },
      destination: { lat: 39.5296, lon: -119.8138, label: "Reno, NV, USA" },
      loadLbs: 42_000,
      interval: 10,
      hos: true,
    },
  },
  {
    title: "Chicago → Nashville",
    note: "Midwest overnight run",
    trip: {
      origin: { lat: 41.8781, lon: -87.6298, label: "Chicago, IL, USA" },
      destination: { lat: 36.1627, lon: -86.7816, label: "Nashville, TN, USA" },
      loadLbs: 28_000,
      interval: 25,
      hos: true,
    },
  },
  {
    title: "Los Angeles → New York",
    note: "Coast to coast, 6 HOS stops",
    trip: {
      origin: { lat: 34.0522, lon: -118.2437, label: "Los Angeles, CA, USA" },
      destination: { lat: 40.7128, lon: -74.006, label: "New York, NY, USA" },
      loadLbs: 38_000,
      interval: 50,
      hos: true,
    },
  },
];

export function templateToDraft(trip: TripTemplate, departureLocal = nextFullHourInput()): TripDraft {
  return {
    origin: trip.origin,
    destination: trip.destination,
    departureLocal,
    loadText: formatLoadLbs(trip.loadLbs).replace(/\s*lb$/, ""),
    interval: trip.interval,
    hos: trip.hos,
  };
}

export function draftToTemplate(draft: TripDraft): TripTemplate | null {
  const loadLbs = parseLoadLbs(draft.loadText);
  if (!draft.origin || !draft.destination || loadLbs == null) return null;
  return { origin: draft.origin, destination: draft.destination, loadLbs, interval: draft.interval, hos: draft.hos };
}

// ---------------------------------------------------------------------------------------------
// Recent trips: the last few planned trips, kept in this browser only.
// ---------------------------------------------------------------------------------------------

const RECENT_KEY = "headwind-recent-trips";
const RECENT_MAX = 4;

function sameTrip(a: TripTemplate, b: TripTemplate): boolean {
  return a.origin.label === b.origin.label && a.destination.label === b.destination.label;
}

function isTemplate(value: unknown): value is TripTemplate {
  const trip = value as TripTemplate;
  const point = (p: GeoPoint | undefined) =>
    !!p && typeof p.lat === "number" && typeof p.lon === "number" && typeof p.label === "string";
  return (
    !!trip &&
    point(trip.origin) &&
    point(trip.destination) &&
    typeof trip.loadLbs === "number" &&
    [10, 25, 50].includes(trip.interval) &&
    typeof trip.hos === "boolean"
  );
}

export function loadRecentTrips(storage: Pick<Storage, "getItem"> | null = safeStorage()): TripTemplate[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isTemplate).slice(0, RECENT_MAX) : [];
  } catch {
    // Corrupt or blocked storage just means no history.
    return [];
  }
}

/** Puts `trip` first, drops older duplicates of the same origin/destination, keeps the newest few. */
export function rememberTrip(
  trip: TripTemplate,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
): TripTemplate[] {
  const next = [trip, ...loadRecentTrips(storage).filter((item) => !sameTrip(item, trip))].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Quota or privacy mode: the list still updates for this visit.
  }
  return next;
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Shareable links: ?from=lat,lon,label&to=lat,lon,label&at=YYYY-MM-DDTHH:mm&load=35000&every=25&hos=1
// ---------------------------------------------------------------------------------------------

function encodePoint(point: GeoPoint): string {
  return `${point.lat.toFixed(5)},${point.lon.toFixed(5)},${point.label}`;
}

function decodePoint(value: string | null): GeoPoint | null {
  if (!value) return null;
  const [lat, lon, ...rest] = value.split(",");
  const point = { lat: Number(lat), lon: Number(lon), label: rest.join(",").trim() };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
    return null;
  }
  return { ...point, label: point.label || `${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}` };
}

export function draftToSearch(draft: TripDraft): string {
  const trip = draftToTemplate(draft);
  if (!trip) return "";
  const params = new URLSearchParams({
    from: encodePoint(trip.origin),
    to: encodePoint(trip.destination),
    at: draft.departureLocal,
    load: String(trip.loadLbs),
    every: String(trip.interval),
    hos: trip.hos ? "1" : "0",
  });
  return `?${params.toString()}`;
}

/**
 * Reads a shared trip. A departure that has already passed is moved to the next full hour, since
 * the API only plans departures from about now on.
 */
export function searchToDraft(search: string, now = new Date()): TripDraft | null {
  const params = new URLSearchParams(search);
  const origin = decodePoint(params.get("from"));
  const destination = decodePoint(params.get("to"));
  const load = Number(params.get("load"));
  const every = Number(params.get("every"));
  if (!origin || !destination || !Number.isFinite(load) || load < 0 || load > 80_000) return null;
  const interval = ([10, 25, 50] as const).find((value) => value === every) ?? 25;
  const at = params.get("at") ?? "";
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) && new Date(at).getTime() >= now.getTime() - 60 * 60_000;
  return templateToDraft(
    { origin, destination, loadLbs: Math.round(load), interval, hos: params.get("hos") !== "0" },
    valid ? at : nextFullHourInput(now),
  );
}
