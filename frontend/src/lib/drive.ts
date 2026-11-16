import type { RouteOption } from "../api/types";
import { formatDuration, formatMiles, formatShortClock } from "./format";
import { riskColor, riskLabel } from "./riskColor";
import type { Timeline, TripSample } from "./tripTimeline";

export interface Ahead {
  tone: "risk" | "stop" | "clear" | "done";
  text: string;
  level?: number;
}

/** What the driver meets next: the nearest elevated-risk checkpoint, else the next HOS stop. */
export function lookAhead(route: RouteOption, timeline: Timeline, sample: TripSample): Ahead {
  if (sample.progress >= 1) return { tone: "done", text: `Arrived · ${formatShortClock(route.arrival)}` };
  if (sample.stop) {
    const left = Math.max(0, Math.round((sample.stop.endMs - sample.tMs) / 60_000));
    return { tone: "stop", text: `${sample.stop.label} · back on the road in ${formatDuration(left * 60)}` };
  }
  const hazard = route.checkpoints.find(
    (checkpoint, index) => index > sample.checkpoint && checkpoint.level != null && checkpoint.level >= 2,
  );
  const stop = timeline.stops.find((item) => item.startMs > sample.tMs);
  const hazardMiles = hazard ? hazard.mile - sample.mile : Infinity;
  const stopMiles = stop ? stop.mile - sample.mile : Infinity;
  if (hazard && hazardMiles <= stopMiles) {
    return {
      tone: "risk",
      level: hazard.level ?? undefined,
      text: `${riskLabel(hazard.level)} weather in ${formatMiles(Math.max(0, hazardMiles))} · ${hazard.reasons[0] ?? ""}`.replace(/ · $/, ""),
    };
  }
  if (stop) return { tone: "stop", text: `${stop.label} in ${formatMiles(Math.max(0, stopMiles))}` };
  return { tone: "clear", text: "Clear weather to the destination" };
}

/** Risk-coloured trip bar: each checkpoint paints the miles it owns (half of each adjacent gap). */
export function progressGradient(route: RouteOption, timeline: Timeline): string {
  const miles = timeline.checkpointMiles;
  const total = Math.max(timeline.distanceMi, 1e-6);
  const stops: string[] = [];
  route.checkpoints.forEach((checkpoint, index) => {
    const from = index === 0 ? 0 : (miles[index - 1] + miles[index]) / 2;
    const to = index === miles.length - 1 ? total : (miles[index] + miles[index + 1]) / 2;
    const color = riskColor(checkpoint.level);
    stops.push(`${color} ${((from / total) * 100).toFixed(2)}%`, `${color} ${((to / total) * 100).toFixed(2)}%`);
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
