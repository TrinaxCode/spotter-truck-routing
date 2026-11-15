import type { RouteOption } from "../api/types";
import { formatCompactClock, formatInchesPerHour, formatMiles, formatShortClock, formatSpeedMph } from "./format";
import { ownershipRanges } from "./routeSegments";
import { milesByLevelLabel, riskLabel } from "./riskColor";
import { nearestCheckpoint, timeAtMile, type Timeline } from "./tripTimeline";

/**
 * Geometry of the weather profile (SPEC §12.2). Pure: the component supplies a pixel width, this
 * returns every coordinate, so the scales can be tested without a DOM.
 *
 *   band     risk level of each checkpoint's owned miles
 *   plot     sustained wind, with the four wind thresholds drawn as level-coloured rules
 *   precip   rain + snow per checkpoint, in/hr
 *   axis     mile and ETA ticks
 */
export const PROFILE_HEIGHT = 186;
export const PAD_X = 8;
const BAND = { top: 0, height: 10 };
const PLOT = { top: 24, height: 76 };
/** HOS stops sit on their own row between the wind plot and the precipitation bars. */
const STOPS = { top: 105, height: 15 };
const PRECIP = { top: 125, height: 24 };
const AXIS_TOP = 155;
/** Sustained wind thresholds (mph) and the level each one opens. */
export const WIND_THRESHOLDS: { mph: number; level: 1 | 2 | 3 | 4 }[] = [
  { mph: 25, level: 1 },
  { mph: 35, level: 2 },
  { mph: 45, level: 3 },
  { mph: 55, level: 4 },
];

export interface ProfileBand {
  x: number;
  width: number;
  level: number | null;
  index: number;
}

export interface ProfilePrecip {
  x: number;
  width: number;
  /** Heights in px, stacked from the baseline: rain first, snow above it. */
  rainHeight: number;
  snowHeight: number;
  index: number;
}

export interface ProfileBreak {
  x: number;
  label: string;
  kind: "break" | "rest";
}

export interface ProfileTick {
  x: number;
  mile: number;
  anchor: "start" | "middle" | "end";
  /** Mile label, e.g. "Mile 280". */
  top: string;
  /** Local ETA, e.g. "Mon 8:12 PM". */
  bottom: string;
}

export interface ProfileModel {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plot: { top: number; bottom: number };
  precip: { top: number; bottom: number };
  band: { top: number; height: number };
  stops: { top: number; height: number };
  axisTop: number;
  distanceMi: number;
  windMax: number;
  precipMax: number;
  x: (mile: number) => number;
  mileAt: (px: number) => number;
  yWind: (mph: number) => number;
  bands: ProfileBand[];
  /** Wind line as SVG path segments; a gap in the forecast starts a new segment. */
  windLines: string[];
  windAreas: string[];
  windPoints: { x: number; y: number; index: number; wind: number }[];
  thresholds: { mph: number; level: number; y: number }[];
  bars: ProfilePrecip[];
  breaks: ProfileBreak[];
  ticks: ProfileTick[];
}

function niceCeil(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/** Wind axis: always shows the 55 mph No Travel line, grows past it for extreme forecasts. */
export function windDomain(maxWind: number): number {
  return Math.max(60, niceCeil(maxWind, 10));
}

/** Precipitation axis in in/hr: at least 0.5 so a drizzle stays small, nice steps above that. */
export function precipDomain(maxTotal: number): number {
  if (maxTotal <= 0.5) return 0.5;
  if (maxTotal <= 1) return 1;
  return niceCeil(maxTotal, 1);
}

export function buildProfile(route: RouteOption, timeline: Timeline, width: number): ProfileModel {
  const plotLeft = PAD_X;
  const plotRight = Math.max(plotLeft + 1, width - PAD_X);
  const distance = Math.max(route.distance_mi, 0.1);
  const x = (mile: number) => plotLeft + (Math.min(Math.max(mile, 0), distance) / distance) * (plotRight - plotLeft);
  const mileAt = (px: number) => Math.min(Math.max(((px - plotLeft) / (plotRight - plotLeft)) * distance, 0), distance);

  const checkpoints = route.checkpoints;
  const winds = checkpoints.map((checkpoint) => checkpoint.weather?.wind_mph ?? null);
  const windMax = windDomain(Math.max(0, ...winds.map((wind) => wind ?? 0)));
  const plotBottom = PLOT.top + PLOT.height;
  const yWind = (mph: number) => plotBottom - (Math.min(Math.max(mph, 0), windMax) / windMax) * PLOT.height;

  const precipTotals = checkpoints.map(
    (checkpoint) => (checkpoint.weather?.rain_in_hr ?? 0) + (checkpoint.weather?.snow_in_hr ?? 0),
  );
  const precipMax = precipDomain(Math.max(0, ...precipTotals));
  const precipBottom = PRECIP.top + PRECIP.height;
  const barHeight = (value: number) => (Math.min(Math.max(value, 0), precipMax) / precipMax) * PRECIP.height;

  const ranges = ownershipRanges(checkpointMilesOf(route), route.distance_mi);
  const bands: ProfileBand[] = [];
  const bars: ProfilePrecip[] = [];
  ranges.forEach((range, index) => {
    const left = x(range.start);
    const right = x(range.end);
    const checkpoint = checkpoints[index];
    bands.push({ x: left, width: Math.max(0, right - left), level: checkpoint.level, index });
    const weather = checkpoint.weather;
    if (!weather) return;
    // A 1 px gap keeps neighbouring bars readable as separate hours of exposure.
    const inner = Math.max(0, right - left - 1);
    bars.push({
      x: left + 0.5,
      width: inner,
      rainHeight: barHeight(weather.rain_in_hr),
      snowHeight: barHeight(weather.snow_in_hr),
      index,
    });
  });

  const windPoints: ProfileModel["windPoints"] = [];
  const windLines: string[] = [];
  const windAreas: string[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) run.push({ x: run[0].x + 0.01, y: run[0].y });
    if (run.length >= 2) {
      const line = run.map((point, i) => `${i === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join("");
      windLines.push(line);
      windAreas.push(`${line}L${run[run.length - 1].x.toFixed(1)} ${plotBottom}L${run[0].x.toFixed(1)} ${plotBottom}Z`);
    }
    run = [];
  };
  checkpoints.forEach((checkpoint, index) => {
    const wind = winds[index];
    if (wind == null) {
      flush();
      return;
    }
    const point = { x: x(checkpoint.mile), y: yWind(wind) };
    run.push(point);
    windPoints.push({ ...point, index, wind });
  });
  flush();

  const breaks: ProfileBreak[] = timeline.stops.map((stop) => ({
    x: x(stop.mile),
    label: stop.label,
    kind: stop.kind,
  }));

  // Four labelled ticks while there is room for them side by side, three on a very narrow chart.
  const fractions = width < 300 ? [0, 0.5, 1] : [0, 1 / 3, 2 / 3, 1];
  const ticks: ProfileTick[] = fractions.map((fraction, i, all) => {
    const mile = Math.round(distance * fraction);
    return {
      x: x(mile),
      mile,
      anchor: i === 0 ? "start" : i === all.length - 1 ? "end" : "middle",
      top: `Mile ${mile}`,
      bottom: formatCompactClock(new Date(timeAtMile(timeline, mile)).toISOString()),
    };
  });

  return {
    width,
    height: PROFILE_HEIGHT,
    plotLeft,
    plotRight,
    plot: { top: PLOT.top, bottom: plotBottom },
    precip: { top: PRECIP.top, bottom: precipBottom },
    band: BAND,
    stops: STOPS,
    axisTop: AXIS_TOP,
    distanceMi: distance,
    windMax,
    precipMax,
    x,
    mileAt,
    yWind,
    bands,
    windLines,
    windAreas,
    windPoints,
    thresholds: WIND_THRESHOLDS.filter((item) => item.mph <= windMax).map((item) => ({ ...item, y: yWind(item.mph) })),
    bars,
    breaks,
    ticks,
  };
}

function checkpointMilesOf(route: RouteOption): number[] {
  return route.checkpoints.map((checkpoint) => checkpoint.mile);
}

export interface ProfileReadout {
  mile: number;
  tMs: number;
  /** Checkpoint that owns the mile, or -1 when the route has none. */
  checkpoint: number;
  windMph: number | null;
  level: number | null;
}

/** What the weather is at a mile: the owning checkpoint's wind and level, at the truck's ETA there. */
export function readoutAtMile(route: RouteOption, timeline: Timeline, mile: number, tMs?: number): ProfileReadout {
  const index = nearestCheckpoint(timeline.checkpointMiles, mile);
  const checkpoint = index >= 0 ? route.checkpoints[index] : undefined;
  return {
    mile,
    tMs: tMs ?? timeAtMile(timeline, mile),
    checkpoint: index,
    windMph: checkpoint?.weather?.wind_mph ?? null,
    level: checkpoint?.level ?? null,
  };
}

/** "Mile 412 · Tue 3:10 AM · Wind 31 mph · High" */
export function formatReadout(readout: ProfileReadout): string {
  const wind = readout.windMph == null ? "Wind unavailable" : `Wind ${formatSpeedMph(readout.windMph)}`;
  return [
    `Mile ${Math.round(readout.mile)}`,
    formatShortClock(new Date(readout.tMs).toISOString()),
    wind,
    readout.level == null ? "Unknown" : riskLabel(readout.level),
  ].join(" · ");
}

/** Text twin of the chart for screen readers. */
export function profileSummary(route: RouteOption, timeline: Timeline): string {
  const parts = [`Weather profile for ${route.label}, ${formatMiles(route.distance_mi)}.`];
  let peak: { wind: number; mile: number } | null = null;
  let wet: { total: number; mile: number } | null = null;
  for (const checkpoint of route.checkpoints) {
    const weather = checkpoint.weather;
    if (!weather) continue;
    if (!peak || weather.wind_mph > peak.wind) peak = { wind: weather.wind_mph, mile: checkpoint.mile };
    const total = weather.rain_in_hr + weather.snow_in_hr;
    if (!wet || total > wet.total) wet = { total, mile: checkpoint.mile };
  }
  if (peak) parts.push(`Peak sustained wind ${formatSpeedMph(peak.wind)} near mile ${Math.round(peak.mile)}.`);
  if (wet && wet.total > 0) {
    parts.push(`Heaviest precipitation ${formatInchesPerHour(wet.total)} near mile ${Math.round(wet.mile)}.`);
  } else if (peak) {
    parts.push("No rain or snow expected along the route.");
  }
  parts.push(`Risk by distance: ${milesByLevelLabel(route.summary.miles_by_level)}.`);
  if (timeline.stops.length > 0) {
    parts.push(
      `${timeline.stops.map((stop) => `${stop.label} near mile ${Math.round(stop.mile)}`).join(", ")}.`,
    );
  }
  if (route.summary.weather_coverage < 1) parts.push("Forecast is missing for part of the route.");
  return parts.join(" ");
}
