# SPEC — Weather-Aware Truck Routing (Spotter take-home)

Source of truth for every agent. The original brief is `fs-assessment-spotter.pdf`.
If something here contradicts the PDF, the PDF wins — tell the orchestrator.

## 1. Brief (verbatim requirements)

User enters origin, destination, departure date/time, load weight. The app must:

1. Generate **3 route options** using a routing API.
2. Sample weather every **10 / 25 / 50 miles** using the truck's **estimated arrival time** at each checkpoint.
3. Calculate weather risk with the risk/load rules below.
4. Recommend the best route balancing weather risk and travel time.
5. Show all routes, checkpoints, risk levels, ETAs and route summaries on a map.
6. Show a weather **heatmap along the trip corridor** with a **0–48 h forecast slider**.

Evaluation: 40% routes/weather/risk/recommendation logic · 40% UI, map & heatmap smoothness/performance · 15% code quality · 5% docs.
**Correctness and clarity over extra features.**

## 2. Stack

- `backend/`: Python 3.12, Django 5.x + Django REST Framework, `requests`, `pytest` + `pytest-django`, `responses` (HTTP mocking), gunicorn, whitenoise, django-cors-headers. Managed with `uv` (`pyproject.toml` + `uv.lock`), plus an exported `requirements.txt`.
- `frontend/`: Vite + React 19 + TypeScript strict, MapLibre GL JS, Tailwind CSS v4. Vitest + Testing Library; Playwright for E2E. Basemap: keyless vector style (OpenFreeMap `https://tiles.openfreemap.org/styles/positron` or `.../liberty`; dark variant allowed).
- Deploy: backend on Railway (`backend/railway.json`), frontend on Vercel (`VITE_API_URL`). Keys only server-side.

## 3. External APIs (decided)

| Need | Provider | Notes |
|---|---|---|
| Routing | **TomTom Routing API** `calculateRoute` | `travelMode=truck`, `vehicleCommercial=true`, `vehicleWeight=<gross kg>`, `maxAlternatives=2`, `departAt`, `routeRepresentation=polyline`, `instructionsType=coded` (instructions carry `routeOffsetInMeters` + `travelTimeInSeconds` → used for ETA interpolation). Key: `TOMTOM_API_KEY`. Verify every parameter against the official docs before coding. |
| Geocoding | TomTom Search API (fuzzy search / geocode) | Limit to `countrySet=US,CA`. Proxied by backend. |
| Weather | **Open-Meteo** `/v1/forecast` | No key. Multi-location batching (comma-separated lat/lon), `wind_speed_unit=mph`, `precipitation_unit=inch`, `timezone=GMT`, `timeformat=unixtime`, hourly `wind_speed_10m,wind_gusts_10m,rain,showers,snowfall,temperature_2m,weather_code`, `forecast_days=16`. Optional `OPEN_METEO_API_KEY` → commercial host. |

Why not OpenRouteService: the public ORS API limits `alternative_routes` to 100 km total route distance, useless for trucking.

**Alternative-route fallback (provider-agnostic):** if the provider returns fewer than 3 distinct routes, generate more by routing through a via-point offset perpendicular to the origin→destination midpoint (±15% of straight-line distance, then ±30% if needed). A candidate is "distinct" if < 80% of its sampled points lie within 2 mi of an existing route. Return at most 3; if still fewer, return what exists plus a warning. Never fabricate routes.

## 4. Domain rules (exact — tests must pin every boundary)

Levels: `LOW=0, MODERATE=1, HIGH=2, SEVERE=3, NO_TRAVEL=4` (`IntEnum`). Labels: `Low, Moderate, High, Severe, No Travel`.

Boundary convention: ranges in the brief are read as **lower-bound inclusive, upper-bound exclusive** (`25–34 mph` ⇒ `25 ≤ w < 35`), because values are continuous. Where the brief uses a strict `>` for the top class, the shared boundary stays in the lower class.

| Condition | Low | Moderate | High | Severe | No Travel |
|---|---|---|---|---|---|
| Wind (sustained, mph) | `< 25` | `[25, 35)` | `[35, 45)` | `[45, 55)` | `≥ 55` |
| Rain (in/hr) | `< 0.10` | `[0.10, 0.25)` | `[0.25, 0.50)` | `[0.50, 1.00]` | `> 1.00` |
| Snow (in/hr) | `< 0.5` | `[0.5, 1.0)` | `[1.0, 2.0)` | `[2.0, 3.0]` | `> 3.0` |

Load rules (applied to the wind level; `load_lbs` = cargo weight entered by the user):
- `wind ≥ 55` → `NO_TRAVEL` for any load.
- `45 ≤ wind < 55` and `load_lbs > 30_000` → `NO_TRAVEL`.
- `35 ≤ wind < 45` and `load_lbs > 40_000` → `SEVERE`.
- Load rules only escalate, never reduce.

Checkpoint level = `max(wind_level_after_load, rain_level, snow_level)`. Each assessment returns human-readable `reasons` (e.g. `"Wind 47 mph with 35,000 lb load → No Travel"`).

Inputs to rules: wind = Open-Meteo `wind_speed_10m` (sustained). Gusts are returned and displayed but not classified (thresholds in the brief are sustained-wind thresholds; documented). Rain = `rain + showers` (in/hr). Snow = `snowfall` (in/hr, Open-Meteo returns inches when `precipitation_unit=inch`). Weather value used for a checkpoint = the hourly value of the hour whose interval contains the ETA (Open-Meteo hourly precipitation is the sum over the *preceding* hour, so ETA 14:20 uses the 15:00 row; instantaneous wind uses the nearest hour). Document this.

Missing weather (ETA beyond forecast horizon or provider failure) → level `null`, excluded from averages, route gets `weather_coverage < 1` and a warning. Never silently treat as Low.

## 5. Checkpoints, ETAs, HOS

- `interval_mi ∈ {10, 25, 50}` chosen by the user (default 25).
- Checkpoints at mile 0, `interval`, `2·interval`, … along the route polyline (haversine, scaled so the polyline length equals the provider's reported distance), **plus the destination** always (even if close to the previous one).
- Drive time at a checkpoint: piecewise-linear interpolation of cumulative `travelTimeInSeconds` vs `routeOffsetInMeters` from the provider's instructions (fallback: proportional to distance).
- **HOS toggle** (default on, FMCSA property-carrying simplified): 30-min break after 8 h cumulative driving since the last break/rest; 10-h off-duty after 11 h driving; 14-h window not modelled (documented). `ETA = departure + elapsed_with_breaks(drive_seconds)`.
- Departure validation: `now − 1 h ≤ departure ≤ now + 14 days`. Arrival times beyond the forecast horizon → missing weather (above).

## 6. Route scoring & recommendation

- Each checkpoint **owns** the miles closer to it than to its neighbours (half of each adjacent gap). Owned miles sum to the route distance.
- `miles_by_level` = owned miles summed per level (+ `unknown` for null levels).
- `avg_risk` = owned-miles-weighted mean of level ints over known miles (0–4).
- Ranking key, ascending, lexicographic (brief order, with No Travel ranked worse than Severe). Routes with full weather coverage always rank ahead of routes with unknown miles (missing data must never look safe); then:
  1. `no_travel_mi` (rounded to 0.1)
  2. `severe_mi` (0.1)
  3. `high_mi` (0.1)
  4. `avg_risk` (rounded to 0.01)
  5. `total_time_s` (trip time including HOS breaks)
- Rank 1 = recommended. Explanation lists which criterion decided vs the runner-up (e.g. `"Tied on Severe/High miles; lower average risk (0.42 vs 0.61)"`).
- If every route has `no_travel_mi > 0` → warning "No route is currently safe; consider a later departure" (still rank them).

## 7. API contract (JSON, snake_case)

`GET /api/health` → `{"status":"ok"}`

`GET /api/geocode?q=dallas` → `{"results":[{"label":"Dallas, TX, USA","lat":32.77,"lon":-96.79}]}` (min 3 chars, max 6 results).

`POST /api/routes/plan`
```json
{
  "origin": {"lat": 32.7767, "lon": -96.797, "label": "Dallas, TX"},
  "destination": {"lat": 39.7392, "lon": -104.9903, "label": "Denver, CO"},
  "departure": "2026-11-16T08:00:00-06:00",
  "load_lbs": 35000,
  "interval_mi": 25,
  "hos": true
}
```
Validation: lat ∈ [-90,90], lon ∈ [-180,180], origin ≠ destination, `load_lbs` int in [0, 80000], interval ∈ {10,25,50}. Errors → `400 {"error":{"code":"validation_error","message":"…","fields":{…}}}`; upstream failure → `502 {"error":{"code":"upstream_error","message":"…"}}`.

Response `200`:
```json
{
  "plan_id": "c0ffee12",
  "generated_at": "2026-11-15T14:00:00Z",
  "request": { "...echo of validated input...": true },
  "recommended_route_id": "r1",
  "recommendation": {"route_id":"r1","explanation":["…"]},
  "warnings": ["…"],
  "routes": [{
    "id": "r1", "label": "Route A", "rank": 1, "recommended": true,
    "geometry": {"type":"LineString","coordinates":[[-96.79,32.77],"…"]},
    "distance_mi": 795.2, "drive_time_s": 43200, "total_time_s": 81000,
    "departure": "2026-11-16T14:00:00Z", "arrival": "2026-11-17T12:30:00Z",
    "summary": {
      "miles_by_level": {"low":700.1,"moderate":60,"high":35.1,"severe":0,"no_travel":0,"unknown":0},
      "avg_risk": 0.18, "max_level": 2, "weather_coverage": 1.0, "checkpoint_count": 33,
      "breaks": [{"type":"break_30m","at_mile":480.0,"start":"…","end":"…"}]
    },
    "checkpoints": [{
      "index": 0, "mile": 0.0, "lat": 32.77, "lon": -96.79,
      "eta": "2026-11-16T14:00:00Z",
      "weather": {"wind_mph":12.1,"gust_mph":20.3,"rain_in_hr":0.0,"snow_in_hr":0.0,"temp_f":51.2,"weather_code":3,"forecast_time":"2026-11-16T14:00:00Z"},
      "levels": {"wind":0,"rain":0,"snow":0},
      "level": 0, "level_label": "Low", "reasons": []
    }]
  }]
}
```
Geometry is simplified server-side (Douglas-Peucker, ~0.0005° tolerance, ≤ 3000 points/route). All timestamps ISO-8601 UTC with `Z`.

`GET /api/heatmap?plan_id=c0ffee12` → corridor grid, 49 hourly frames starting at the departure hour (floor):
```json
{
  "plan_id": "c0ffee12", "start": "2026-11-16T14:00:00Z", "hours": 49, "cell_deg": 0.4,
  "load_lbs": 35000,
  "cells": [{"lat": 33.0, "lon": -97.0}],
  "risk":  [[0,0,1,"…49 ints per cell"]],
  "wind":  [[12.1,"…"]], "rain": [[0.0,"…"]], "snow": [[0.0,"…"]]
}
```
Columnar arrays (`risk[i][h]` for `cells[i]`, hour `h`), floats rounded to 2 dp, null where unavailable. Grid: square cells sized from the routes' bbox (`cell_deg = clamp(diag/25, 0.15, 0.75)`), keeping cells whose centre is within `max(30 mi, 1.5 cells)` of any route; cap 300 cells (coarsen if exceeded). Risk uses the plan's load. `404` if plan unknown/expired.

Plans are stored in the Django cache (file-based or DB cache so gunicorn workers share it) for 6 h.

## 8. Caching & resilience

- Weather cache key: coordinate rounded to 0.1° (≈ model grid resolution) + UTC date window; TTL 30 min. Deduplicate checkpoints across routes before calling Open-Meteo; batch ≤ 100 locations per request; retry once on 429/5xx with backoff; timeouts 10 s.
- Routing results cached by (origin, destination, departure hour, load) for 15 min.
- Geocode cached 24 h. All upstream calls have timeouts and raise typed errors mapped to 502.

## 9. UI

Single page "dispatch console". Desktop: left panel (form → route cards) + map; bottom heatmap timeline. Mobile (≤ 768 px): map full screen with a draggable/bottom sheet.

- Form: origin/destination autocomplete (debounced 250 ms, keyboard accessible combobox), departure `datetime-local` (default next full hour, local time), load weight (lb, formatted), interval segmented control 10/25/50, HOS toggle. Submit disabled while invalid/loading.
- Route cards: rank badge, "Recommended", distance, drive time, total time, arrival, stacked bar of miles by level, avg risk, max level, coverage warning. Clicking a card selects/highlights the route (others dimmed, still visible). Recommendation explanation shown.
- Map: all 3 routes; selected route drawn on top and coloured per segment by checkpoint level (line split at owned-mile boundaries or `line-gradient`), others neutral. Checkpoint circles coloured by level, sized for touch; hover/click popup with mile, ETA (local time), wind/gust/rain/snow/temp, level and reasons. Origin/destination markers. Fit bounds on new plan. Legend.
- Heatmap: toggle on/off; variable selector (Risk / Wind / Rain / Snow); slider 0–48 h labeled with local clock time, play/pause, keyboard steps. **Smoothness requirement:** the full 49-frame payload is fetched once; changing hour must only call `setPaintProperty`/`setFeatureState` (no source re-creation, no refetch, no React re-render of the map). Optionally highlight checkpoints whose ETA falls in the selected hour.
- States: skeletons while planning; heatmap loading state independent of routes; empty state (before first plan); error states with retry; validation messages per field.
- Risk palette (colour-blind safe, also encoded with text/icons): Low green, Moderate yellow, High orange, Severe red, No Travel deep purple/black. Respect `prefers-reduced-motion`. WCAG 2.2 AA. UI copy in **English** (US company, US trucking units).

## 10. Definition of done

- Backend: `pytest` green with boundary tests for every threshold and load rule, recommendation order (each tie-break level), checkpoint spacing (incl. destination), ETA interpolation, HOS, owned-miles, heatmap grid; upstream calls mocked (no network in tests). `ruff` clean.
- Frontend: `tsc --noEmit`, `eslint`, `vitest`, `vite build` green; Playwright E2E of plan → select route → slide heatmap against mocked API.
- README: setup, env vars, architecture, every decision above, limitations.
- Deployed: Railway backend + Vercel frontend, verified in a browser at 375/768/1280 px with clean console.

## 11. Backend module interface (pure functions — tests import these)

Django project `backend/config/`, app `backend/planner/`, services in `backend/planner/services/`.

```python
# planner/services/risk.py
class RiskLevel(IntEnum): LOW=0; MODERATE=1; HIGH=2; SEVERE=3; NO_TRAVEL=4
def wind_level(wind_mph: float) -> RiskLevel
def rain_level(rain_in_hr: float) -> RiskLevel
def snow_level(snow_in_hr: float) -> RiskLevel
def wind_level_with_load(wind_mph: float, load_lbs: float) -> RiskLevel
@dataclass(frozen=True)
class Assessment: level: RiskLevel; wind: RiskLevel; rain: RiskLevel; snow: RiskLevel; reasons: tuple[str, ...]
def assess(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lbs: float) -> Assessment

# planner/services/sampling.py
@dataclass(frozen=True)
class Checkpoint: index: int; mile: float; lon: float; lat: float
def sample_checkpoints(coords: Sequence[tuple[float, float]], interval_mi: float,
                       total_distance_mi: float | None = None) -> list[Checkpoint]  # coords are (lon, lat)
def owned_miles(checkpoint_miles: Sequence[float], total_mi: float) -> list[float]

# planner/services/hos.py
def elapsed_with_breaks(drive_seconds: float, enabled: bool = True) -> float
def break_schedule(total_drive_seconds: float) -> list[Break]   # Break(type, drive_seconds_at, duration_s)

# planner/services/recommend.py
@dataclass(frozen=True)
class RouteScore: route_id: str; miles_by_level: Mapping[str, float]  # keys low..no_travel, unknown
                  avg_risk: float; total_time_s: float
def score_route(route_id: str, owned: Sequence[float], levels: Sequence[RiskLevel | None], total_time_s: float) -> RouteScore
def rank_routes(scores: Sequence[RouteScore]) -> list[RouteScore]   # best first
def explain(ranked: Sequence[RouteScore]) -> list[str]
```

## 12. Extensions (deepen the core decision, no unrelated features)

### 12.1 Departure options — "Best time to leave"
`GET /api/departure-options?plan_id=<id>` → re-scores the plan's routes for departures shifted by `offset_h ∈ {0,1,…,24}` from the plan's departure.
- **No new routing calls**: route geometry, checkpoints, drive times and HOS schedule are reused (HOS depends only on drive time, so each checkpoint ETA shifts by exactly the offset). Assumption documented: traffic-dependent drive time at a later hour is not re-queried.
- Weather comes from the same cached Open-Meteo forecasts (`fetch_forecasts` on the plan's checkpoint coordinates; normally all cache hits). Same `select_weather`, `assess`, `owned_miles`, `score_route`, `rank_routes` as the plan — no duplicated rules.
- Response:
```json
{
  "plan_id": "…", "base_departure": "…Z",
  "options": [{
    "offset_h": 0, "departure": "…Z", "best_route_id": "r1",
    "routes": [{"route_id": "r1", "miles_by_level": {"low":…,"moderate":…,"high":…,"severe":…,"no_travel":…,"unknown":…},
                "avg_risk": 0.12, "max_level": 2, "weather_coverage": 1.0, "total_time_s": 81000, "arrival": "…Z"}]
  }],
  "suggestion": {"offset_h": 3, "departure": "…Z", "route_id": "r2",
                 "headline": "Leave 3 h later on Route B to avoid 42 mi of Severe weather.",
                 "improvement": {"no_travel_mi": 0, "severe_mi": 42.0, "high_mi": 10.5}} 
}
```
- `suggestion` = the option whose best route has the lowest **risk key** (coverage-complete first, no_travel, severe, high, avg_risk — same rounding as §6, *without* total time), earliest offset on ties. It is `null` unless that risk key is strictly better than offset 0's best route. `headline` names the largest improvement (No Travel > Severe > High > average risk).
- Options whose departure would exceed the forecast horizon simply get `null` levels / coverage < 1 (never treated as Low). `404` for unknown plan. Cached with the plan TTL.

### 12.2 Weather profile (frontend only)
Per selected route: SVG chart over route miles — risk band (owned miles coloured by level), sustained wind line (mph), precipitation bars (rain + snow in/hr), HOS break markers, ETA labels at a few ticks. Hover/focus a mile → highlight the nearest checkpoint on the map (feature-state / paint only). Keyboard accessible (arrow keys move the cursor), with a text summary for screen readers.

### 12.3 Trip playback (frontend only)
Play animates a truck marker along the selected route by wall-clock time (position interpolated from checkpoint `eta` / `mile` and the geometry, paused during HOS breaks), synchronised with the heatmap hour (frame = truck time, clamped to 0–48 h). The truck lives in its own tiny GeoJSON source (1 feature) — the only source updated per animation frame; the heatmap still changes via paint only. Speed control (e.g. 1 h of trip per second), respects `prefers-reduced-motion` (step mode), keyboard accessible.
