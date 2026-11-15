import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cumulativeMiles, haversineMi, ownedMiles, pointAlong, type LngLat } from "../src/lib/geo.ts";
import { RISK_LABELS, assess, type RiskLevel } from "../src/mocks/assess.ts";
import { breakSchedule, elapsedWithBreaks } from "../src/mocks/hos.ts";
import { sampleField } from "../src/mocks/weatherField.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "mocks");

const DEPARTURE = "2026-11-16T14:00:00Z";
const GENERATED_AT = "2026-11-15T14:00:00Z";
const LOAD = 35_000;
const SPEED_MPH = 55;

const ORIGIN = { lat: 32.7767, lon: -96.797, label: "Dallas, TX, USA" };
const DESTINATION = { lat: 39.7392, lon: -104.9903, label: "Denver, CO, USA" };

const ROUTES: { id: string; label: string; waypoints: LngLat[] }[] = [
  {
    id: "r1",
    label: "Route A",
    waypoints: [
      [-96.797, 32.7767],
      [-97.1331, 33.2148],
      [-97.1436, 34.1743],
      [-97.5164, 35.4676],
      [-97.2889, 36.2898],
      [-97.3301, 37.6872],
      [-97.427, 38.048],
      [-97.6114, 38.8403],
      [-98.8598, 38.8953],
      [-99.3268, 38.8792],
      [-100.874, 39.3483],
      [-101.7103, 39.3508],
      [-102.2693, 39.3017],
      [-103.6922, 39.2639],
      [-104.6, 39.55],
      [-104.9903, 39.7392],
    ],
  },
  {
    id: "r2",
    label: "Route B",
    waypoints: [
      [-96.797, 32.7767],
      [-97.5861, 33.2343],
      [-98.4934, 33.9137],
      [-99.2651, 34.1545],
      [-100.204, 34.4264],
      [-100.8882, 34.9378],
      [-101.8313, 35.222],
      [-101.9732, 35.8656],
      [-102.5132, 36.0595],
      [-103.2, 36.55],
      [-104.4391, 36.9034],
      [-104.5005, 37.1695],
      [-104.78, 37.6242],
      [-104.6091, 38.2544],
      [-104.8214, 38.8339],
      [-104.869, 39.3722],
      [-104.9903, 39.7392],
    ],
  },
  {
    id: "r3",
    label: "Route C",
    waypoints: [
      [-96.797, 32.7767],
      [-97.7973, 32.7593],
      [-99.7331, 32.4487],
      [-100.4059, 32.4709],
      [-101.8552, 33.5779],
      [-103.2052, 34.4048],
      [-104.2458, 34.4717],
      [-104.6824, 34.9387],
      [-105.2228, 35.5942],
      [-104.7072, 36.0078],
      [-104.5933, 36.3614],
      [-104.4391, 36.9034],
      [-104.5005, 37.1695],
      [-104.78, 37.6242],
      [-104.6091, 38.2544],
      [-104.8214, 38.8339],
      [-104.9903, 39.7392],
    ],
  },
];

const PLACES = [
  ORIGIN,
  DESTINATION,
  { label: "Fort Worth, TX, USA", lat: 32.7555, lon: -97.3308 },
  { label: "Oklahoma City, OK, USA", lat: 35.4676, lon: -97.5164 },
  { label: "Amarillo, TX, USA", lat: 35.222, lon: -101.8313 },
  { label: "Lubbock, TX, USA", lat: 33.5779, lon: -101.8552 },
  { label: "Wichita, KS, USA", lat: 37.6872, lon: -97.3301 },
  { label: "Colorado Springs, CO, USA", lat: 38.8339, lon: -104.8214 },
  { label: "Kansas City, MO, USA", lat: 39.0997, lon: -94.5786 },
  { label: "Houston, TX, USA", lat: 29.7604, lon: -95.3698 },
  { label: "Austin, TX, USA", lat: 30.2672, lon: -97.7431 },
  { label: "San Antonio, TX, USA", lat: 29.4241, lon: -98.4936 },
  { label: "Albuquerque, NM, USA", lat: 35.0844, lon: -106.6504 },
  { label: "Phoenix, AZ, USA", lat: 33.4484, lon: -112.074 },
  { label: "Chicago, IL, USA", lat: 41.8781, lon: -87.6298 },
  { label: "Atlanta, GA, USA", lat: 33.749, lon: -84.388 },
  { label: "Los Angeles, CA, USA", lat: 34.0522, lon: -118.2437 },
  { label: "Salt Lake City, UT, USA", lat: 40.7608, lon: -111.891 },
  { label: "Omaha, NE, USA", lat: 41.2565, lon: -95.9345 },
];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function toZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addSeconds(iso: string, seconds: number): string {
  return toZ(Date.parse(iso) + seconds * 1000);
}

/** Open-Meteo hourly row that closes the hour containing the ETA. Exact hours use that row. */
function forecastHourIndex(startMs: number, etaMs: number): number {
  const hourMs = 3_600_000;
  const offset = etaMs - startMs;
  if (offset < 0) return -1;
  if (offset % hourMs === 0) return offset / hourMs;
  return Math.floor(offset / hourMs) + 1;
}

function densify(points: LngLat[], stepMi: number): LngLat[] {
  const out: LngLat[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dist = haversineMi(a, b);
    const steps = Math.max(1, Math.ceil(dist / stepMi));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out.map(([lon, lat]) => [round4(lon), round4(lat)]);
}

function roundBuckets(
  raw: Record<string, number>,
  total: number,
): Record<"low" | "moderate" | "high" | "severe" | "no_travel" | "unknown", number> {
  const keys = ["low", "moderate", "high", "severe", "no_travel", "unknown"] as const;
  const out = {
    low: 0,
    moderate: 0,
    high: 0,
    severe: 0,
    no_travel: 0,
    unknown: 0,
  };
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

interface Checkpoint {
  index: number;
  mile: number;
  lat: number;
  lon: number;
  eta: string;
  weather: {
    wind_mph: number;
    gust_mph: number;
    rain_in_hr: number;
    snow_in_hr: number;
    temp_f: number;
    weather_code: number;
    forecast_time: string;
  } | null;
  levels: { wind: RiskLevel; rain: RiskLevel; snow: RiskLevel } | null;
  level: RiskLevel | null;
  level_label: string;
  reasons: string[];
}

function buildRoute(
  spec: (typeof ROUTES)[number],
  interval: number,
  blankIndex: number | null,
) {
  const coords = densify(spec.waypoints, 12);
  const cum = cumulativeMiles(coords);
  const raw = cum[cum.length - 1] ?? 0;
  const distance = round1(raw);
  const scale = distance / raw;
  const drive = Math.round((distance / SPEED_MPH) * 3600);
  const total = elapsedWithBreaks(drive, true);
  const targets: number[] = [];
  for (let mile = 0; mile < distance - 0.05; mile += interval) targets.push(round1(mile));
  if (targets[targets.length - 1] !== distance) targets.push(distance);

  const startMs = Date.parse(DEPARTURE);
  const checkpoints: Checkpoint[] = targets.map((mile, index) => {
    const [lon, lat] = pointAlong(coords, cum, mile / scale);
    const driveAt = distance === 0 ? 0 : Math.round((mile / distance) * drive);
    const elapsed = elapsedWithBreaks(driveAt, true);
    const etaMs = startMs + elapsed * 1000;
    const hour = forecastHourIndex(startMs, etaMs);
    const blank = index === blankIndex;
    if (blank || hour < 0 || hour >= 49) {
      return {
        index,
        mile,
        lat: round4(lat),
        lon: round4(lon),
        eta: toZ(etaMs),
        weather: null,
        levels: null,
        level: null,
        level_label: "Unknown",
        reasons: ["Weather is unavailable at this checkpoint's ETA."],
      };
    }
    const sample = sampleField(lat, lon, hour);
    const assessed = assess(sample.windMph, sample.rainInHr, sample.snowInHr, LOAD);
    return {
      index,
      mile,
      lat: round4(lat),
      lon: round4(lon),
      eta: toZ(etaMs),
      weather: {
        wind_mph: sample.windMph,
        gust_mph: sample.gustMph,
        rain_in_hr: sample.rainInHr,
        snow_in_hr: sample.snowInHr,
        temp_f: sample.tempF,
        weather_code: sample.weatherCode,
        forecast_time: toZ(startMs + hour * 3_600_000),
      },
      levels: { wind: assessed.wind, rain: assessed.rain, snow: assessed.snow },
      level: assessed.level,
      level_label: RISK_LABELS[assessed.level],
      reasons: assessed.reasons,
    };
  });

  const shares = ownedMiles(
    checkpoints.map((checkpoint) => checkpoint.mile),
    distance,
  );
  const rawBuckets = { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 };
  let known = 0;
  let weighted = 0;
  let max: number | null = null;
  checkpoints.forEach((checkpoint, index) => {
    const share = shares[index] ?? 0;
    if (checkpoint.level == null) {
      rawBuckets.unknown += share;
      return;
    }
    const key = (["low", "moderate", "high", "severe", "no_travel"] as const)[checkpoint.level];
    rawBuckets[key] += share;
    known += share;
    weighted += checkpoint.level * share;
    max = max == null ? checkpoint.level : Math.max(max, checkpoint.level);
  });

  const breaks = breakSchedule(drive).map((item) => ({
    type: item.type,
    at_mile: round1((item.atDriveS / drive) * distance),
    start: addSeconds(DEPARTURE, item.elapsedAtStartS),
    end: addSeconds(DEPARTURE, item.elapsedAtStartS + item.durationS),
  }));

  return {
    id: spec.id,
    label: spec.label,
    rank: 0,
    recommended: false,
    geometry: { type: "LineString" as const, coordinates: coords },
    distance_mi: distance,
    drive_time_s: drive,
    total_time_s: total,
    departure: DEPARTURE,
    arrival: addSeconds(DEPARTURE, total),
    summary: {
      miles_by_level: roundBuckets(rawBuckets, distance),
      avg_risk: known > 0 ? Math.round((weighted / known) * 100) / 100 : 0,
      max_level: max,
      weather_coverage: distance > 0 ? Math.round((known / distance) * 1000) / 1000 : 0,
      checkpoint_count: checkpoints.length,
      breaks,
    },
    checkpoints,
  };
}

function rankKey(route: ReturnType<typeof buildRoute>): number[] {
  const miles = route.summary.miles_by_level;
  return [
    round1(miles.no_travel),
    round1(miles.severe),
    round1(miles.high),
    route.summary.avg_risk,
    route.total_time_s,
  ];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function explain(best: ReturnType<typeof buildRoute>, other: ReturnType<typeof buildRoute>): string[] {
  const pairs: [keyof ReturnType<typeof buildRoute>["summary"]["miles_by_level"], string][] = [
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
      return [
        `${prefix} ${label} miles than ${other.label} (${left.toFixed(1)} vs ${right.toFixed(1)})`,
      ];
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

function buildPlan(interval: 10 | 25 | 50) {
  const blankIndex = interval === 25 ? 4 : null;
  const built = ROUTES.map((spec) =>
    buildRoute(spec, interval, spec.id === "r3" ? blankIndex : null),
  );
  const ranked = [...built].sort((a, b) => compareKeys(rankKey(a), rankKey(b)));
  ranked.forEach((route, index) => {
    route.rank = index + 1;
    route.recommended = index === 0;
  });
  const warnings: string[] = [];
  if (ranked.every((route) => route.summary.miles_by_level.no_travel > 0)) {
    warnings.push("No route is currently safe; consider a later departure");
  }
  for (const route of ranked) {
    if (route.summary.weather_coverage < 1) {
      warnings.push(
        `Weather is missing on part of ${route.label}; those miles are excluded from the average.`,
      );
    }
  }
  const best = ranked[0];
  const runner = ranked[1];
  return {
    plan_id: `c0ffee${interval}`,
    generated_at: GENERATED_AT,
    request: {
      origin: ORIGIN,
      destination: DESTINATION,
      departure: DEPARTURE,
      load_lbs: LOAD,
      interval_mi: interval,
      hos: true,
    },
    recommended_route_id: best.id,
    recommendation: {
      route_id: best.id,
      explanation: runner ? explain(best, runner) : ["Only route available"],
    },
    warnings,
    routes: ranked,
  };
}

function pointToSegmentMi(lon: number, lat: number, a: LngLat, b: LngLat): number {
  const cos = Math.cos((lat * Math.PI) / 180);
  const ax = a[0] * cos * 69;
  const ay = a[1] * 69;
  const bx = b[0] * cos * 69;
  const by = b[1] * 69;
  const px = lon * cos * 69;
  const py = lat * 69;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToRoutesMi(lat: number, lon: number, lines: LngLat[][]): number {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      best = Math.min(best, pointToSegmentMi(lon, lat, line[i - 1], line[i]));
    }
  }
  return best;
}

function buildHeatmap(lines: LngLat[][]) {
  const lats = lines.flat().map((coord) => coord[1]);
  const lons = lines.flat().map((coord) => coord[0]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const diag = Math.hypot(maxLat - minLat, maxLon - minLon);
  let cell = Math.min(0.75, Math.max(0.15, diag / 25));

  const collect = (cellDeg: number) => {
    const buffer = Math.max(30, 1.5 * cellDeg * 69);
    const cells: { lat: number; lon: number }[] = [];
    const startLat = Math.floor(minLat / cellDeg) * cellDeg + cellDeg / 2;
    const startLon = Math.floor(minLon / cellDeg) * cellDeg + cellDeg / 2;
    for (let lat = startLat; lat <= maxLat + cellDeg; lat += cellDeg) {
      for (let lon = startLon; lon <= maxLon + cellDeg; lon += cellDeg) {
        if (distanceToRoutesMi(lat, lon, lines) <= buffer) {
          cells.push({ lat: round4(lat), lon: round4(lon) });
        }
      }
    }
    return cells;
  };

  let cells = collect(cell);
  while (cells.length > 300 && cell < 0.75) {
    cell = Math.min(0.75, Math.round(cell * 1.25 * 1000) / 1000);
    cells = collect(cell);
  }
  cell = Math.round(cell * 1000) / 1000;

  const risk: (number | null)[][] = [];
  const wind: (number | null)[][] = [];
  const rain: (number | null)[][] = [];
  const snow: (number | null)[][] = [];
  for (const cellPoint of cells) {
    const riskRow: (number | null)[] = [];
    const windRow: (number | null)[] = [];
    const rainRow: (number | null)[] = [];
    const snowRow: (number | null)[] = [];
    for (let hour = 0; hour < 49; hour += 1) {
      const sample = sampleField(cellPoint.lat, cellPoint.lon, hour);
      const assessed = assess(sample.windMph, sample.rainInHr, sample.snowInHr, LOAD);
      riskRow.push(assessed.level);
      windRow.push(sample.windMph);
      rainRow.push(sample.rainInHr);
      snowRow.push(sample.snowInHr);
    }
    risk.push(riskRow);
    wind.push(windRow);
    rain.push(rainRow);
    snow.push(snowRow);
  }

  return {
    plan_id: "c0ffee25",
    start: DEPARTURE,
    hours: 49,
    cell_deg: cell,
    load_lbs: LOAD,
    cells,
    risk,
    wind,
    rain,
    snow,
  };
}

const plans = {
  10: buildPlan(10),
  25: buildPlan(25),
  50: buildPlan(50),
};

const lines = ROUTES.map((spec) => densify(spec.waypoints, 12));
const heatmap = buildHeatmap(lines);

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "plans.json"),
  JSON.stringify(
    {
      canonical_departure: DEPARTURE,
      load_lbs: LOAD,
      origin: ORIGIN,
      destination: DESTINATION,
      plans,
    },
    null,
    2,
  ),
);
writeFileSync(join(outDir, "heatmap.json"), JSON.stringify(heatmap));
writeFileSync(join(outDir, "places.json"), JSON.stringify(PLACES, null, 2));

for (const interval of [10, 25, 50] as const) {
  console.log(`\ninterval ${interval} plan ${plans[interval].plan_id}`);
  console.log(`  warning: ${plans[interval].warnings.join(" | ") || "(none)"}`);
  console.log(`  explain: ${plans[interval].recommendation.explanation.join(" ")}`);
  for (const route of plans[interval].routes) {
    const miles = route.summary.miles_by_level;
    const levels = route.checkpoints.map((checkpoint) => checkpoint.level_label ?? "Unknown");
    console.log(
      `  #${route.rank} ${route.label} ${route.distance_mi} mi drive ${route.drive_time_s}s total ${route.total_time_s}s avg ${route.summary.avg_risk} max ${route.summary.max_level} cov ${route.summary.weather_coverage}`,
    );
    console.log(
      `     NT ${miles.no_travel} sev ${miles.severe} high ${miles.high} mod ${miles.moderate} low ${miles.low} unk ${miles.unknown} cps ${route.summary.checkpoint_count}`,
    );
    console.log(`     levels ${levels.join(", ")}`);
  }
}
console.log(`\nheatmap cells ${heatmap.cells.length} cell_deg ${heatmap.cell_deg}`);
