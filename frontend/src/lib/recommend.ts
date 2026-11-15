import type { PlanResponse, RouteOption } from "../api/types";
import { formatDuration } from "./format";

export interface Recommendation {
  /** Sentence naming the route and why it wins, in dispatcher terms. */
  headline: string;
  /**
   * True when the pick should not read as a clean all-clear: the winner crosses No Travel or
   * Severe miles, or the forecast is incomplete so the pick is provisional.
   */
  caution: boolean;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function miles(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} mi`;
}

/** Why the route wins, for a winner with no No Travel or Severe miles. */
function riskPhrase(route: RouteOption, partial: boolean): string {
  const { high } = route.summary.miles_by_level;
  // With gaps in the forecast "none" only holds for the stretch that has data.
  const known = partial ? " where the forecast is known" : "";
  if (round1(high) > 0) return `no Severe miles${known} and only ${miles(high)} of High risk`;
  return `no Severe or High miles${known}`;
}

/** "10 mi of No Travel and 3.2 mi of Severe conditions", or "" when the route has neither. */
function hazardPhrase(route: RouteOption): string {
  const { no_travel, severe } = route.summary.miles_by_level;
  const parts: string[] = [];
  if (round1(no_travel) > 0) parts.push(`${miles(no_travel)} of No Travel`);
  if (round1(severe) > 0) parts.push(`${miles(severe)} of Severe`);
  return parts.length > 0 ? `${parts.join(" and ")} conditions` : "";
}

/** "Route B (94% covered)"; floored so a gap never rounds up to "100% covered". */
function coveragePhrase(route: RouteOption): string {
  return `${route.label} (${Math.floor(route.summary.weather_coverage * 100)}% covered)`;
}

function timePhrase(route: RouteOption, other: RouteOption | undefined): string {
  if (!other) return "";
  const delta = other.total_time_s - route.total_time_s;
  if (Math.abs(delta) < 300) return `about as fast as ${other.label}`;
  const span = formatDuration(Math.abs(delta));
  return delta > 0 ? `${span} faster than ${other.label}` : `${span} slower than ${other.label}`;
}

/**
 * Plain-language summary of the backend's rank-1 route; the backend's own explanation stays
 * available. The wording never claims more than the data supports:
 * - a winner that crosses No Travel or Severe miles is never "safest" ("has the least risk, but
 *   crosses ..."), and
 * - any route with missing forecast makes the pick provisional ("best available pick").
 * Both set `caution`, so the callout does not show the green all-clear.
 */
export function describeRecommendation(plan: PlanResponse): Recommendation | null {
  const ordered = [...plan.routes].sort((a, b) => a.rank - b.rank);
  const best = ordered.find((route) => route.id === plan.recommended_route_id) ?? ordered[0];
  if (!best) return null;
  const runnerUp = ordered.find((route) => route.id !== best.id);
  const hazard = hazardPhrase(best);
  const incomplete = plan.routes.filter((route) => route.summary.weather_coverage < 1);
  const partial = best.summary.weather_coverage < 1;
  const time = timePhrase(best, runnerUp);

  const tail = time ? ` (${time})` : "";
  if (incomplete.length > 0) {
    const gaps = incomplete.map(coveragePhrase).join(", ");
    if (hazard) {
      return {
        headline: `${best.label} is the best available pick, but it crosses ${hazard}${tail}. Forecast data is incomplete for ${gaps}.`,
        caution: true,
      };
    }
    const detail = [riskPhrase(best, partial), time].filter(Boolean).join(", ");
    return {
      headline: `${best.label} is the best available pick, but forecast data is incomplete for ${gaps}: ${detail}.`,
      caution: true,
    };
  }
  if (hazard) {
    return { headline: `${best.label} has the least risk, but crosses ${hazard}${tail}.`, caution: true };
  }
  const parts = [riskPhrase(best, false), time].filter(Boolean);
  return { headline: `${best.label} is safest: ${parts.join(", ")}.`, caution: false };
}
