import type { DepartureOption, DepartureOptionsResponse, DepartureRouteScore, RiskLevel } from "../api/types";
import { riskColor, riskLabel } from "./riskColor";

/**
 * View model of the "best time to leave" strip (SPEC §12.1): one bar per hourly departure, coloured
 * by the worst level on that departure's best route, as tall as its risky miles
 * (High + Severe + No Travel) relative to the riskiest departure shown.
 */

/** Fraction of the strip's height for a departure with no risky miles: a visible baseline tick. */
export const MIN_BAR = 0.08;
/** A departure with any risky miles starts here, so one High mile is never mistaken for none. */
const FLOOR_BAR = 0.2;

export interface StripBar {
  offset: number;
  departure: string;
  routeId: string;
  routeLabel: string;
  /** 0..1 share of the strip height. */
  height: number;
  level: RiskLevel | null;
  color: string;
  riskyMi: number;
  highMi: number;
  /** Severe plus No Travel miles. */
  severeMi: number;
  /** True when part of the route has no forecast; the bar is hatched, never read as safe. */
  partial: boolean;
  /** Plain-text description shared by the tooltip and the accessible name. */
  text: string;
  /** Local clock label for the departure. */
  timeLabel: string;
}

function score(option: DepartureOption): DepartureRouteScore | undefined {
  return option.routes.find((route) => route.route_id === option.best_route_id) ?? option.routes[0];
}

export function riskyMiles(route: DepartureRouteScore): number {
  const miles = route.miles_by_level;
  return miles.high + miles.severe + miles.no_travel;
}

/** Bar height as a fraction of the strip: baseline for none, linear in risky miles above a floor. */
export function barHeight(riskyMi: number, maxRiskyMi: number): number {
  if (riskyMi <= 0 || maxRiskyMi <= 0) return MIN_BAR;
  return FLOOR_BAR + (1 - FLOOR_BAR) * Math.min(1, riskyMi / maxRiskyMi);
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });

function formatMi(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

/** "+3 h · 8:00 PM · Route B · 0 mi Severe or worse · 12 mi High" */
export function describeBar(bar: Pick<StripBar, "offset" | "timeLabel" | "routeLabel" | "severeMi" | "highMi" | "partial" | "level">): string {
  const when = bar.offset === 0 ? "Planned departure" : `+${bar.offset} h`;
  const parts = [
    when,
    bar.timeLabel,
    bar.routeLabel,
    `${formatMi(bar.severeMi)} mi Severe or worse`,
    `${formatMi(bar.highMi)} mi High`,
  ];
  if (bar.partial) parts.push("forecast incomplete");
  return parts.join(" · ");
}

export function stripBars(
  data: DepartureOptionsResponse,
  labelOf: (routeId: string) => string,
): StripBar[] {
  const options = [...data.options].sort((a, b) => a.offset_h - b.offset_h);
  const scored = options.map((option) => ({ option, best: score(option) }));
  const maxRisky = Math.max(0, ...scored.map(({ best }) => (best ? riskyMiles(best) : 0)));
  const baseDay = new Date(Date.parse(data.base_departure)).toDateString();
  return scored.map(({ option, best }) => {
    const date = new Date(Date.parse(option.departure));
    const timeLabel = (date.toDateString() === baseDay ? clock : dayClock).format(date).replace(",", "");
    const riskyMi = best ? riskyMiles(best) : 0;
    const level = best?.max_level ?? null;
    const bar = {
      offset: option.offset_h,
      departure: option.departure,
      routeId: option.best_route_id,
      routeLabel: labelOf(option.best_route_id),
      height: barHeight(riskyMi, maxRisky),
      level,
      color: riskColor(level),
      riskyMi,
      highMi: best?.miles_by_level.high ?? 0,
      severeMi: best ? best.miles_by_level.severe + best.miles_by_level.no_travel : 0,
      partial: best ? best.weather_coverage < 1 || best.miles_by_level.unknown > 0 : true,
      timeLabel,
    };
    return { ...bar, text: describeBar(bar) };
  });
}

/** Spoken summary of the strip for the group label. */
export function stripSummary(bars: readonly StripBar[]): string {
  if (bars.length === 0) return "No departure options.";
  const calm = bars.filter((bar) => bar.level != null && bar.level <= 1).length;
  const worst = bars.reduce<RiskLevel | null>(
    (max, bar) => (bar.level != null && (max == null || bar.level > max) ? bar.level : max),
    null,
  );
  return `Departures over the next ${bars[bars.length - 1].offset} hours. ${calm} of ${bars.length} stay at Moderate or better. Worst level on any best route: ${riskLabel(worst)}.`;
}

/** Copy for "no better time": names the planned time instead of "now" when it is not now. */
export function isDepartingNow(departureIso: string, generatedAtIso: string): boolean {
  const gap = Date.parse(departureIso) - Date.parse(generatedAtIso);
  return Number.isNaN(gap) || gap < 90 * 60_000;
}

export function stayLabel(departureIso: string, generatedAtIso: string): string {
  const lead = isDepartingNow(departureIso, generatedAtIso) ? "Leaving now" : "Leaving at your planned time";
  return `${lead} is already the lowest-risk option in the next 24 h.`;
}
