import type { PlanResponse, RouteOption } from "../api/types";
import { ownedMiles } from "../lib/geo";

const LEVEL_KEYS = ["low", "moderate", "high", "severe", "no_travel"] as const;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundBuckets(raw: Record<string, number>, total: number): RouteOption["summary"]["miles_by_level"] {
  const keys = ["low", "moderate", "high", "severe", "no_travel", "unknown"] as const;
  const out = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };
  let sum = 0;
  for (const key of keys) {
    out[key] = round1(raw[key] ?? 0);
    sum += out[key];
  }
  let drift = round1(round1(total) - sum);
  const order = [...keys].sort((a, b) => out[b] - out[a]);
  for (const key of order) {
    if (drift === 0) break;
    if (out[key] + drift < 0) continue;
    out[key] = round1(out[key] + drift);
    drift = 0;
  }
  return out;
}

function rankKey(route: RouteOption): number[] {
  const miles = route.summary.miles_by_level;
  return [round1(miles.no_travel), round1(miles.severe), round1(miles.high), route.summary.avg_risk, route.total_time_s];
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function explain(best: RouteOption, other: RouteOption): string[] {
  const pairs: [keyof RouteOption["summary"]["miles_by_level"], string][] = [
    ["no_travel", "No Travel"],
    ["severe", "Severe"],
    ["high", "High"],
  ];
  const tied: string[] = [];
  for (const [key, label] of pairs) {
    const left = round1(best.summary.miles_by_level[key]);
    const right = round1(other.summary.miles_by_level[key]);
    if (left !== right) {
      const prefix = tied.length > 0 ? `Tied on ${tied.join("/")} miles; fewer` : "Fewer";
      return [`${prefix} ${label} miles than ${other.label} (${left.toFixed(1)} vs ${right.toFixed(1)})`];
    }
    tied.push(label);
  }
  if (best.summary.avg_risk !== other.summary.avg_risk) {
    return [
      `Tied on ${tied.join("/")} miles; lower average risk (${best.summary.avg_risk.toFixed(2)} vs ${other.summary.avg_risk.toFixed(2)})`,
    ];
  }
  return [`Tied on risk; shorter total time than ${other.label}`];
}

/** Recomputes miles, average risk, rank, explanation, and warnings from checkpoint levels. */
export function rescore(plan: PlanResponse): void {
  for (const route of plan.routes) {
    const shares = ownedMiles(
      route.checkpoints.map((checkpoint) => checkpoint.mile),
      route.distance_mi,
    );
    const raw = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };
    let known = 0;
    let weighted = 0;
    let max: number | null = null;
    route.checkpoints.forEach((checkpoint, index) => {
      const share = shares[index] ?? 0;
      if (checkpoint.level == null) {
        raw.unknown += share;
        return;
      }
      raw[LEVEL_KEYS[checkpoint.level]] += share;
      known += share;
      weighted += checkpoint.level * share;
      max = max == null ? checkpoint.level : Math.max(max, checkpoint.level);
    });
    route.summary.miles_by_level = roundBuckets(raw, route.distance_mi);
    route.summary.avg_risk = known > 0 ? Math.round((weighted / known) * 100) / 100 : 0;
    route.summary.max_level = max as RouteOption["summary"]["max_level"];
    route.summary.weather_coverage =
      route.distance_mi > 0 ? Math.round((known / route.distance_mi) * 1000) / 1000 : 0;
    route.summary.checkpoint_count = route.checkpoints.length;
  }

  const ranked = [...plan.routes].sort((a, b) => compare(rankKey(a), rankKey(b)));
  ranked.forEach((route, index) => {
    route.rank = index + 1;
    route.recommended = index === 0;
  });
  plan.routes = ranked;
  plan.recommended_route_id = ranked[0]?.id ?? "";
  plan.recommendation = {
    route_id: plan.recommended_route_id,
    explanation: ranked[0] && ranked[1] ? explain(ranked[0], ranked[1]) : ["Only route available"],
  };
  const warnings: string[] = [];
  if (ranked.length > 0 && ranked.every((route) => route.summary.miles_by_level.no_travel > 0)) {
    warnings.push("No route is currently safe; consider a later departure");
  }
  for (const route of ranked) {
    if (route.summary.weather_coverage < 1) {
      warnings.push(`Weather is missing on part of ${route.label}; those miles are excluded from the average.`);
    }
  }
  plan.warnings = warnings;
}
