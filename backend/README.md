# Spotter backend

Python 3.12, Django 5.2 and Django REST Framework. Run commands from `backend/`.
The API uses real TomTom routes and Open-Meteo forecasts; it never substitutes demo routes.

## Local setup

```sh
uv sync --frozen
cp .env.example .env
# Add TOMTOM_API_KEY to .env. DEBUG=true supports local HTTP without a production secret.
uv run python manage.py runserver 8000
```

No database migrations are needed: the service has no application models. `/api/health`
works without provider credentials. A valid planning request without `TOMTOM_API_KEY`
returns HTTP 503 with `error.code=not_configured`; geocoding has the same safeguard.

## Environment

| Variable | Default / purpose |
| --- | --- |
| `DJANGO_SECRET_KEY` | Required with `DEBUG=false`; set it in the Railway service variables. |
| `DEBUG` | `false`; set `true` for local development. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1`; comma-separated production hostnames. |
| `CORS_ALLOWED_ORIGINS` | Local Vite origin in debug; otherwise empty. Set the exact frontend origin. |
| `TOMTOM_API_KEY` | Required for truck routing and geocoding. Server-side only. |
| `OPEN_METEO_API_KEY` | Optional commercial key; selects the customer forecast host. |
| `CACHE_DIR` | `backend/.cache`; private writable filesystem shared by all workers. |
| `TRUCK_TARE_LBS` | `35000`; assumed tractor/trailer empty weight, added to cargo for routing. |
| `THROTTLE_PLAN`, `THROTTLE_GEOCODE`, `THROTTLE_PLAN_DATA` | Per-IP limits (`12/min`, `60/min`, `120/min`); 429 with `Retry-After` and the error envelope. |
| `NUM_PROXIES` | `0` locally; set `1` on Railway so limits key on the client IP from `X-Forwarded-For`, not the proxy. |
| `SECURE_SSL_REDIRECT` | `true` in production, `false` in debug. |
| `RAILWAY_PUBLIC_DOMAIN` | Provided by Railway; it and `healthcheck.railway.app` are allowed hosts automatically. |

Keep credentials in `.env` locally and the deployment environment in production.
Never expose the cache directory through a static/media server: Django's file cache
uses pickle and must only be writable by the service account.

## API and architecture

- `GET /api/health`: `{"status":"ok"}`.
- `GET /api/geocode?q=Dallas`: at most six US/Canada suggestions; query minimum three characters.
- `POST /api/routes/plan`: exact SPEC §7 snake_case contract, UTC timestamps ending in `Z`.
- `GET /api/heatmap?plan_id=...`: at most 300 corridor cells, each with 49 hourly values.
- `GET /api/departure-options?plan_id=...`: 25 departures (0–24 h later), each route's risk/coverage/time/arrival, and a strictly safer suggestion or `null`; validated plan ID, same error envelope, 404 for unknown/expired plans, cached until the plan expires.

DRF serializers validate coordinates, distinct endpoints, timezone-aware departure
within −1 hour/+14 days, integer cargo weight 0–80,000 lb, interval 10/25/50 and HOS.
Validation/parsing errors have `error.code=validation_error` and `error.fields` (400).
Routing/geocode provider failures have `error.code=upstream_error` (502), without
credential-bearing request URLs or provider bodies. Unknown/expired plans return 404.
Every error, including unknown `/api/*` paths (404 `not_found`) and unexpected crashes (500
`internal_error`), uses the same `{"error":{"code","message","fields?"}}` envelope. `fields` is
DRF's shape: field → list of messages, nested for `origin`/`destination`. Timestamps are
whole-second UTC (`…Z`).
Weather failures are recoverable: affected data is `null` and planning includes warnings.
A heatmap built while any forecast batch failed is returned but not cached, so a retry
refetches instead of pinning an empty map for six hours.

`planner/services/` separates pure risk, sampling, HOS and scoring from provider adapters.
`routing.py` exposes a small `RoutingProvider` protocol. `planner.py` deduplicates weather
lookups across every route, computes checkpoints/ETAs, evaluates owned-mile risks,
assigns ranks and stores the plan. `heatmap.py` independently computes the corridor
payload so the frontend fetches it once and updates the slider without more requests.

The shared file cache holds plans for 6 hours, routing for 15 minutes, geocoding for
24 hours, and weather for 30 minutes. Weather keys include coordinates rounded to
0.1° and the UTC date window. Batches have at most 100 locations. HTTP timeouts are
10 seconds; 429/5xx get one retry after a short backoff. Failed weather batches do
not erase successful batches or populate the cache with fabricated observations.

## Decisions and limitations

- Departure options reuse checkpoint coordinates and exact drive/HOS ETA offsets with one deduplicated forecast fetch; the earliest minimum risk key (coverage, No Travel/Severe/High miles at 0.1 mi, average risk at 0.01, excluding time) wins only if strictly better than offset 0. Headlines name the highest-priority improvement; signed mileage differences use those rounded values. Traffic-dependent drive times are not queried again, and weather beyond the horizon stays unknown.
- **Coverage correction from review:** routes with complete weather coverage rank
  before any route with unknown miles; within each group, the SPEC §6 lexicographic
  key applies (No Travel, Severe, High, average risk, total time, with specified rounding).
  The all-unknown numeric average remains 0 for §11 compatibility, but cannot beat
  a fully covered route. Missing data stays `null`, contributes to `unknown` miles
  and produces a coverage warning; a wholly incomplete comparison is provisional.
- Wind uses sustained speed. Gusts are display-only. Cargo load only escalates wind
  risk. Rain is rain + showers; snowfall is snow depth in inches, not water equivalent.
- ETA 14:20 uses the 15:00 precipitation row, representing the preceding hour.
  Sustained wind, temperature, code and display gusts use the nearest hour; exact
  half-hour ties select the later row. `forecast_time` identifies the precipitation row;
  the displayed weather combines the two documented sample times. Gusts themselves
  are preceding-hour maxima, not instantaneous measurements.
- `forecast_days=16` plus `past_days=1` covers allowed departures just before UTC
  midnight. ETAs outside the returned horizon and invalid/null weather remain unknown.
- Cargo weight is not gross vehicle weight. The configurable 35,000 lb tare assumption
  supplies TomTom's gross kilograms; risk rules still use cargo only. Vehicle dimensions,
  axle restrictions and hazardous cargo are outside this form's contract.
- Requested alternatives are deduplicated using sampled proximity to route segments.
  If needed, real provider requests use perpendicular midpoint offsets ±15%, then
  ±30% of the straight-line displacement. Unroutable via points are skipped. If fewer
  than three distinct routes exist, return the available routes with a warning.
- Checkpoint distance follows scaled haversine geometry. Guidance supplies cumulative
  travel-time interpolation; missing guidance falls back to proportional travel time.
  Response geometry uses iterative Douglas–Peucker (~0.0005°, coarsened if needed
  to stay at 3,000 points), retaining origin/destination.
- HOS is the simplified SPEC model: 30 minutes after 8 driving hours, 10 hours after
  11; no 14-hour duty window or weekly rules. No post-destination rest is added.
- The heatmap starts at departure hour floor; risk uses this plan's cargo load.
  Initial cells use `clamp(bbox diagonal / 25, .15, .75)` in degrees; the 300-cell
  cap takes precedence and can coarsen beyond .75°. The corridor uses 30 miles or
  1.5 latitude-side cell widths, whichever is larger. It is a forecast snapshot.
- File caching shares workers on one machine; horizontal scaling needs a different
  shared backend. Cache eviction can expire plans early. The corridor projection is
  intended for continental US/Canada routes; dateline-crossing/polar routes are not supported.

## Verification

```sh
uv run pytest -q
uv run ruff check .
uv run python manage.py check --deploy   # With production environment variables
uv run python manage.py collectstatic --noinput
uv export --frozen --no-dev --no-emit-project --format requirements-txt --output-file requirements.txt
```

See [docs/verification.md](docs/verification.md) for official API documentation checked,
and actual check results.
Tests mock HTTP with `responses`; no test calls real providers.
`tests/test_frontend_contract.py` pins the real plan/heatmap/departure payloads the frontend tests load
(`frontend/src/mocks/backend-*.sample.json`); after an API change run
`WRITE_SAMPLES=1 uv run pytest -q tests/test_frontend_contract.py` and commit the samples. Tests under `tests/spec/` are a black-box suite written independently from SPEC.md.

## Railway

Create a service from the GitHub repo with **Root Directory** `/backend` and **Config File**
`/backend/railway.json` (the config path does not follow the root directory). Railpack detects
`pyproject.toml` + `uv.lock`, the build runs `collectstatic`, and the service starts gunicorn
(two workers, four threads) with `/api/health` as the health check, which is exempt from the HTTPS
redirect because Railway probes it over plain HTTP. Variables: `DJANGO_SECRET_KEY`, `TOMTOM_API_KEY`,
`CORS_ALLOWED_ORIGINS` (the Vercel origin) and `CACHE_DIR=/tmp/spotter-cache` (file cache shared by the
workers of one instance; a restart clears it). Generate a public domain under Networking.
