/** SPEC §7 contract. Timestamps in responses are ISO-8601 UTC with a Z suffix. */
import type { FieldIssues } from "./errors";

export interface GeoPoint {
  lat: number;
  lon: number;
  label: string;
}

export interface PlanRequest {
  origin: GeoPoint;
  destination: GeoPoint;
  departure: string;
  load_lbs: number;
  interval_mi: 10 | 25 | 50;
  hos: boolean;
}

export interface HealthResponse {
  status: string;
}

export interface GeocodeResponse {
  results: GeoPoint[];
}

/** `fields` follows DRF: field -> message list, or a nested object for origin/destination. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    fields?: FieldIssues;
  };
}

export type RiskLevel = 0 | 1 | 2 | 3 | 4;

export interface MilesByLevel {
  low: number;
  moderate: number;
  high: number;
  severe: number;
  no_travel: number;
  unknown: number;
}

export interface DutyBreak {
  type: string;
  at_mile: number;
  start: string;
  end: string;
}

export interface RouteSummary {
  miles_by_level: MilesByLevel;
  avg_risk: number;
  max_level: RiskLevel | null;
  weather_coverage: number;
  checkpoint_count: number;
  breaks: DutyBreak[];
}

export interface CheckpointWeather {
  wind_mph: number;
  gust_mph: number;
  rain_in_hr: number;
  snow_in_hr: number;
  temp_f: number;
  weather_code: number;
  forecast_time: string;
  /** Direction the wind blows from, degrees clockwise from north; null or absent when unknown. */
  wind_dir_deg?: number | null;
}

/** Present only when the checkpoint has weather. Component levels are then known ints. */
export interface CheckpointLevels {
  wind: RiskLevel;
  rain: RiskLevel;
  snow: RiskLevel;
}

/**
 * Matches planner.serialize output.
 * Missing weather: weather and levels and level are null, level_label is "Unknown".
 * summary.max_level is null when every checkpoint on the route is unknown.
 */
export interface Checkpoint {
  index: number;
  mile: number;
  lat: number;
  lon: number;
  eta: string;
  weather: CheckpointWeather | null;
  levels: CheckpointLevels | null;
  level: RiskLevel | null;
  level_label: string;
  reasons: string[];
}

export interface RouteGeometry {
  type: "LineString";
  coordinates: [number, number][];
}

export interface RouteOption {
  id: string;
  label: string;
  rank: number;
  recommended: boolean;
  geometry: RouteGeometry;
  distance_mi: number;
  drive_time_s: number;
  total_time_s: number;
  departure: string;
  arrival: string;
  summary: RouteSummary;
  checkpoints: Checkpoint[];
}

export interface PlanResponse {
  plan_id: string;
  generated_at: string;
  request: PlanRequest;
  recommended_route_id: string;
  recommendation: {
    route_id: string;
    explanation: string[];
  };
  warnings: string[];
  routes: RouteOption[];
}

export interface HeatmapCell {
  lat: number;
  lon: number;
}

export interface HeatmapResponse {
  plan_id: string;
  start: string;
  hours: number;
  cell_deg: number;
  load_lbs: number;
  cells: HeatmapCell[];
  risk: (number | null)[][];
  wind: (number | null)[][];
  rain: (number | null)[][];
  snow: (number | null)[][];
  /**
   * Wind direction (from, degrees) per cell and hour; drives the wind animation only. Optional:
   * plans cached before it existed and demo data omit it.
   */
  wind_dir?: (number | null)[][];
}

export type HeatVariable = "risk" | "wind" | "rain" | "snow";

/** SPEC §12.1: one route re-scored for a shifted departure. */
export interface DepartureRouteScore {
  route_id: string;
  miles_by_level: MilesByLevel;
  avg_risk: number;
  max_level: RiskLevel | null;
  weather_coverage: number;
  total_time_s: number;
  arrival: string;
}

export interface DepartureOption {
  offset_h: number;
  departure: string;
  best_route_id: string;
  routes: DepartureRouteScore[];
}

export interface DepartureSuggestion {
  offset_h: number;
  departure: string;
  route_id: string;
  headline: string;
  improvement: { no_travel_mi: number; severe_mi: number; high_mi: number };
}

export interface DepartureOptionsResponse {
  plan_id: string;
  base_departure: string;
  options: DepartureOption[];
  suggestion: DepartureSuggestion | null;
}
