import type { DepartureOption, DepartureRouteScore, DepartureSuggestion } from "../api/types";

/**
 * Demo-mode departure options (SPEC §12.1). The ranking and the suggestion follow the backend's
 * rules: the risk key is coverage-complete first, then No Travel, Severe and High miles (rounded
 * to 0.1) and average risk (0.01), without total time.
 */

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function riskKey(score: DepartureRouteScore): number[] {
  const miles = score.miles_by_level;
  return [
    score.weather_coverage >= 1 && miles.unknown === 0 ? 0 : 1,
    round1(miles.no_travel),
    round1(miles.severe),
    round1(miles.high),
    Math.round(score.avg_risk * 100) / 100,
  ];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Best route for one departure: lowest risk key, then the shortest total time. */
export function bestRoute(routes: readonly DepartureRouteScore[]): DepartureRouteScore | undefined {
  return [...routes].sort(
    (a, b) => compareKeys(riskKey(a), riskKey(b)) || a.total_time_s - b.total_time_s,
  )[0];
}

function miles(value: number): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)} mi`;
}

function hours(offset: number): string {
  return `${offset} h`;
}

/**
 * The option whose best route has the strictly lowest risk key versus offset 0 (earliest offset on
 * ties), or null when leaving at the planned time is already the lowest-risk choice.
 */
export function suggest(
  options: readonly DepartureOption[],
  labelOf: (routeId: string) => string,
): DepartureSuggestion | null {
  const base = options.find((option) => option.offset_h === 0);
  const baseBest = base ? bestRoute(base.routes) : undefined;
  if (!base || !baseBest) return null;
  const baseKey = riskKey(baseBest);
  let pick: { option: DepartureOption; route: DepartureRouteScore; key: number[] } | null = null;
  for (const option of [...options].sort((a, b) => a.offset_h - b.offset_h)) {
    const route = bestRoute(option.routes);
    if (!route) continue;
    const key = riskKey(route);
    if (!pick || compareKeys(key, pick.key) < 0) pick = { option, route, key };
  }
  if (!pick || compareKeys(pick.key, baseKey) >= 0) return null;

  const improvement = {
    no_travel_mi: round1(Math.max(0, baseBest.miles_by_level.no_travel - pick.route.miles_by_level.no_travel)),
    severe_mi: round1(Math.max(0, baseBest.miles_by_level.severe - pick.route.miles_by_level.severe)),
    high_mi: round1(Math.max(0, baseBest.miles_by_level.high - pick.route.miles_by_level.high)),
  };
  const when = pick.option.offset_h === 0 ? "now" : `${hours(pick.option.offset_h)} later`;
  const on = `on ${labelOf(pick.route.route_id)}`;
  let headline: string;
  if (improvement.no_travel_mi > 0) {
    headline = `Leave ${when} ${on} to avoid ${miles(improvement.no_travel_mi)} of No Travel weather.`;
  } else if (improvement.severe_mi > 0) {
    headline = `Leave ${when} ${on} to avoid ${miles(improvement.severe_mi)} of Severe weather.`;
  } else if (improvement.high_mi > 0) {
    headline = `Leave ${when} ${on} to cut High-risk miles by ${miles(improvement.high_mi)}.`;
  } else {
    headline = `Leave ${when} ${on} for a lower average weather risk.`;
  }
  return {
    offset_h: pick.option.offset_h,
    departure: pick.option.departure,
    route_id: pick.route.route_id,
    headline,
    improvement,
  };
}
