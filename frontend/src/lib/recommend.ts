import type { PlanResponse, RouteOption } from "../api/types";
import { formatDuration } from "./format";

export interface Recommendation {
  /** Sentence naming the route and why it wins, in dispatcher terms. */
  headline: string;
  /** True when no route avoids No Travel conditions. */
  caution: boolean;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function miles(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} mi`;
}

function riskPhrase(route: RouteOption): string {
  const { no_travel, severe, high } = route.summary.miles_by_level;
  if (round1(no_travel) > 0) return `fewest No Travel miles (${miles(no_travel)})`;
  if (round1(severe) > 0) return `fewest Severe miles (${miles(severe)})`;
  if (round1(high) > 0) return `no Severe miles and only ${miles(high)} of High risk`;
  return "no Severe or High miles";
}

function timePhrase(route: RouteOption, other: RouteOption | undefined): string {
  if (!other) return "";
  const delta = other.total_time_s - route.total_time_s;
  if (Math.abs(delta) < 300) return `about as fast as ${other.label}`;
  const span = formatDuration(Math.abs(delta));
  return delta > 0 ? `${span} faster than ${other.label}` : `${span} slower than ${other.label}`;
}

/** Plain-language summary of the backend's rank-1 route; the backend's own explanation stays available. */
export function describeRecommendation(plan: PlanResponse): Recommendation | null {
  const ordered = [...plan.routes].sort((a, b) => a.rank - b.rank);
  const best = ordered.find((route) => route.id === plan.recommended_route_id) ?? ordered[0];
  if (!best) return null;
  const runnerUp = ordered.find((route) => route.id !== best.id);
  const allUnsafe = plan.routes.every((route) => round1(route.summary.miles_by_level.no_travel) > 0);
  const fullCoverage = best.summary.weather_coverage >= 1;
  const lead = allUnsafe ? "has the least exposure" : fullCoverage ? "is safest" : "is the safest with a full forecast";
  const parts = [riskPhrase(best), timePhrase(best, runnerUp)].filter(Boolean);
  return { headline: `${best.label} ${lead}: ${parts.join(", ")}.`, caution: allUnsafe };
}
