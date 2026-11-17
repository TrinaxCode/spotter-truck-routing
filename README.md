# Weather-Aware Truck Routing

Plan a truck trip, get three route options, and see which one is safest given the forecast **at the time the truck will actually be there**, its cargo weight, and travel time.

- **Live app:** https://spotter-truck-routing-flame.vercel.app · **API:** https://backend-production-ea6c421c.up.railway.app/api/health · **Walkthrough:** https://www.loom.com/share/28ca99e080584dc0852775b99865385b
- Full spec and decisions: [`SPEC.md`](SPEC.md)

## What it does

1. The driver enters origin, destination, departure time and cargo weight, and picks a checkpoint spacing of 10, 25 or 50 mi.
2. The backend asks TomTom for truck routes, using the gross vehicle weight. If TomTom returns fewer than 3 distinct options, it builds more by routing through via-points.
3. Checkpoints are placed every N miles plus at the destination. Each checkpoint's ETA is interpolated from TomTom's per-instruction travel times. With Hours of Service enabled, the ETA also includes the required 30 min break and 10 h rest.
4. Open-Meteo hourly forecasts (wind in mph, precipitation in inches) are read for each checkpoint's ETA hour and classified with the brief's risk and load rules.
5. Routes are ranked by No Travel miles → Severe miles → High miles → average risk → total time. The recommendation explains which criterion decided it.
6. The map shows every route, checkpoint, risk level and ETA, plus a corridor heatmap with a 0–48 h slider (Risk / Wind / Rain / Snow).
7. Departure options compare the next 24 hours on the same routes and suggest the earliest strictly safer departure, when one exists.

### Beyond the brief

The app also compares departure times, supports a drive-mode preview and a printable driver briefing, and offers sharing and keyboard shortcuts.

## Where to look first

- [`risk.py`](backend/planner/services/risk.py): weather thresholds and load rules.
- [`recommend.py`](backend/planner/services/recommend.py): route scoring and ranking.
- [`weather.select_weather`](backend/planner/services/weather.py): forecast selection at each ETA.
- [`mapController`](frontend/src/map/mapController.ts): map layers and heatmap rendering.

## Architecture

```
frontend/  Vite + React 19 + TypeScript + MapLibre GL (Vercel)
   │  POST /api/routes/plan   GET /api/heatmap?plan_id=   GET /api/geocode?q=
backend/   Django 5 + DRF (Railway)
   planner/services/
     risk.py       thresholds + load rules (pure)
     sampling.py   checkpoints, owned miles, simplification (pure)
     hos.py        simplified FMCSA breaks (pure)
     recommend.py  scoring, ranking, explanation (pure)
     routing.py    TomTom truck routing + via-point alternatives
     weather.py    Open-Meteo batching, dedupe, ETA→hour selection
     heatmap.py    corridor grid × 49 hourly frames
     planner.py    orchestration; plans cached so the heatmap reuses them
```

API keys never reach the browser. Upstream calls have timeouts, a single retry and caching: weather 30 min, routes 15 min, geocoding 24 h, plans 6 h.

## Key decisions

| Topic | Decision | Why |
|---|---|---|
| Routing provider | TomTom (`travelMode=truck`, gross weight, `maxAlternatives=2`) | OpenRouteService's public API only returns alternatives for routes ≤ 100 km. |
| Range boundaries | Lower bound inclusive, upper exclusive (`25–34 mph` ⇒ `25 ≤ w < 35`). Where the brief says `> 1.00` / `> 3.0`, the shared boundary stays in the lower class (Severe). | Values are continuous; this matches every row of the table without gaps or overlaps. |
| Wind | Sustained 10 m wind is classified; gusts are shown but not classified | The thresholds are sustained-wind thresholds. |
| Load rules | Only escalate the wind level; strict `>` on 30,000 / 40,000 lb | As written in the brief. |
| Precipitation hour | An ETA of 14:20 uses the 15:00 row; wind uses the nearest hour | Open-Meteo precipitation is the sum over the preceding hour. |
| Miles per level | Each checkpoint "owns" half of each adjacent gap | Miles sum exactly to the route length, at any spacing. |
| Ranking | No Travel miles are ranked before Severe miles; values are rounded (0.1 mi, 0.01 avg) before comparing | No Travel is worse than Severe; rounding keeps float noise from deciding. |
| Missing weather | Shown as `Unknown`, never treated as Low; routes with full coverage rank first | Missing data must never make a route look safer. |
| HOS | 30 min after 8 h of driving, 10 h after 11 h; the 14 h window is not modelled | Without breaks, ETAs on long trips are off by a day, so the weather would be read for the wrong time. |
| Heatmap | 49 frames fetched once; the slider only updates map paint properties | Sliding never refetches data or re-renders React. |
| Departure options | Reuse drive times/HOS and cached forecasts; compare rounded risk without total time, earliest tie | Suggest only a strict risk improvement; later traffic is not re-queried. |

## Run locally

```sh
# backend (requires uv)
cd backend && uv sync --frozen && cp .env.example .env   # add TOMTOM_API_KEY
uv run python manage.py runserver 8000

# frontend
cd frontend && npm ci && cp .env.example .env.local
npm run dev                          # http://localhost:5173
VITE_USE_MOCKS=true npm run dev      # fully offline demo with fixture data
```

| Variable | Where | Purpose |
|---|---|---|
| `TOMTOM_API_KEY` | backend | Truck routing and geocoding (free key at developer.tomtom.com) |
| `DJANGO_SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS` | backend | Django / CORS |
| `CACHE_DIR`, `TRUCK_TARE_LBS`, `OPEN_METEO_API_KEY` (optional) | backend | Cache location, empty-truck weight for routing, commercial weather access |
| `VITE_API_URL`, `VITE_USE_MOCKS` | frontend | Backend origin, offline demo mode |

## Tests

```sh
cd backend  && uv run pytest -q && uv run ruff check .
cd frontend && npm run typecheck && npm run lint && npm run test && npm run build && npm run e2e
```

- **Backend:** about 525 tests with no network access. They pin every risk boundary and load rule, each ranking tie-break, checkpoint spacing, ETA interpolation, HOS, the heatmap grid and the API error shapes. `tests/spec/` contains spec-level tests organized by `SPEC.md` section.
- **Frontend:** unit tests and a contract test against real backend payloads. Playwright E2E (45 tests) covers plan → select route → slide heatmap → checkpoint popup, drive mode, departure suggestions and touch gestures at 375, 768 and 1280 px, and asserts the slider and the playback never rebuild the map sources.

## Limitations

- The forecast horizon is about 16 days; checkpoints past it are reported as Unknown.
- HOS is simplified: no 14 h duty window, weekly limits or sleeper splits.
- Weather is sampled on a ~0.1° grid (close to the forecast model's resolution). The heatmap is capped at 450 cells.
- The file cache is shared by the workers of a single instance; horizontal scaling would need Redis.
- Route results are cached per departure **hour** (15 min TTL): two departures within the same hour reuse TomTom's geometry and drive times, while every ETA is still computed from the exact departure. Only the traffic pattern used for that hour can differ.
- Concurrent identical requests on a cold cache can both call the upstream APIs (results stay consistent; there is no cross-worker request coalescing).
- A cold plan takes ~6–16 s, almost all of it TomTom truck routing with alternatives (e.g. Los Angeles → New York at 10 mi spacing ≈ 16 s for ~880 checkpoints). Cached plans return in under 1 s.
