import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DepartureOption, DepartureRouteScore, PlanResponse, RiskLevel } from "../src/api/types.ts";
import { ownedMiles } from "../src/lib/geo.ts";
import { assess } from "../src/mocks/assess.ts";
import { suggest } from "../src/mocks/departures.ts";
import { sampleField } from "../src/mocks/weatherField.ts";

/**
 * Demo departure options for each fixture plan (SPEC §12.1): the plan's own checkpoints are
 * re-scored against the same synthetic storm for departures shifted by 0..48 h. Only 0..24 h is
 * part of the contract; the extra day lets the mock re-slice the window after a suggestion has
 * been applied. Run with `npm run fixtures:departures`.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mocks = join(root, "src", "mocks");
const bundle = JSON.parse(readFileSync(join(mocks, "plans.json"), "utf8")) as {
  canonical_departure: string;
  load_lbs: number;
  plans: Record<string, PlanResponse>;
};

const HOUR = 3_600_000;
/** The synthetic field is defined for any hour; the real backend reads a 16-day forecast. */
const MAX_HOUR = 49 + 48;
const KEYS = ["low", "moderate", "high", "severe", "no_travel"] as const;
const startMs = Date.parse(bundle.canonical_departure);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function forecastHour(etaMs: number): number {
  const offset = etaMs - startMs;
  return offset % HOUR === 0 ? offset / HOUR : Math.floor(offset / HOUR) + 1;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function score(plan: PlanResponse, routeIndex: number, offset: number): DepartureRouteScore {
  const route = plan.routes[routeIndex];
  const shares = ownedMiles(route.checkpoints.map((checkpoint) => checkpoint.mile), route.distance_mi);
  const raw = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };
  let known = 0;
  let weighted = 0;
  let max: number | null = null;
  route.checkpoints.forEach((checkpoint, index) => {
    const share = shares[index] ?? 0;
    const hour = forecastHour(Date.parse(checkpoint.eta) + offset * HOUR);
    if (checkpoint.weather == null || hour < 0 || hour >= MAX_HOUR) {
      raw.unknown += share;
      return;
    }
    const sample = sampleField(checkpoint.lat, checkpoint.lon, hour);
    const level = assess(sample.windMph, sample.rainInHr, sample.snowInHr, bundle.load_lbs).level as RiskLevel;
    raw[KEYS[level]] += share;
    known += share;
    weighted += level * share;
    max = max == null ? level : Math.max(max, level);
  });
  const miles_by_level = {
    low: round1(raw.low),
    moderate: round1(raw.moderate),
    high: round1(raw.high),
    severe: round1(raw.severe),
    no_travel: round1(raw.no_travel),
    unknown: round1(raw.unknown),
  };
  // Keep the buckets summing to the route distance, as the backend does.
  const drift = round1(round1(route.distance_mi) - Object.values(miles_by_level).reduce((a, b) => a + b, 0));
  const biggest = (Object.keys(miles_by_level) as (keyof typeof miles_by_level)[]).sort(
    (a, b) => miles_by_level[b] - miles_by_level[a],
  )[0];
  miles_by_level[biggest] = round1(miles_by_level[biggest] + drift);
  return {
    route_id: route.id,
    miles_by_level,
    avg_risk: known > 0 ? Math.round((weighted / known) * 100) / 100 : 0,
    max_level: max,
    weather_coverage: route.distance_mi > 0 ? Math.round((known / route.distance_mi) * 1000) / 1000 : 0,
    total_time_s: route.total_time_s,
    arrival: iso(Date.parse(route.departure) + offset * HOUR + route.total_time_s * 1000),
  };
}

import { bestRoute } from "../src/mocks/departures.ts";

const out: Record<string, unknown> = {};
for (const plan of Object.values(bundle.plans)) {
  const labels = new Map(plan.routes.map((route) => [route.id, route.label]));
  const options: DepartureOption[] = [];
  for (let offset = 0; offset <= 48; offset += 1) {
    const routes = plan.routes.map((_, index) => score(plan, index, offset));
    options.push({
      offset_h: offset,
      departure: iso(Date.parse(plan.routes[0].departure) + offset * HOUR),
      best_route_id: bestRoute(routes)?.route_id ?? "",
      routes,
    });
  }
  out[plan.plan_id] = {
    plan_id: plan.plan_id,
    base_departure: plan.routes[0].departure,
    options,
    suggestion: suggest(options.filter((option) => option.offset_h <= 24), (id) => labels.get(id) ?? id),
  };
}

writeFileSync(join(mocks, "departure-options.mock.json"), `${JSON.stringify(out)}\n`);
console.log("wrote departure-options.mock.json");
