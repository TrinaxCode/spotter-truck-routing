# Backend verification — 2026-11-15

## Official contracts reviewed

- [TomTom Calculate Route](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route):
  URL locations are `latitude,longitude` separated by colons (including via points).
  Verified `travelMode=truck`, `vehicleCommercial=true`, integer `vehicleWeight` in kg,
  offset-aware `departAt`, `maxAlternatives=2`, `routeRepresentation=polyline` and
  `routes[].summary` / `legs[].points` response fields. Fewer alternatives are allowed.
- [TomTom guidance](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/guidance-instructions):
  `instructionsType=coded` returns guidance for alternatives too. Instructions provide
  cumulative `routeOffsetInMeters` and `travelTimeInSeconds`, enabling ETA interpolation.
- [TomTom Fuzzy Search](https://docs.tomtom.com/search-api/documentation/search-service/fuzzy-search):
  verified URL-encoded query, `countrySet=US,CA`, `limit=6`, `results[].position` and
  `address.freeformAddress`. Search v2 remains supported; retained as specified.
- [Open-Meteo forecast](https://open-meteo.com/en/docs): verified comma-separated paired
  coordinates produce a JSON **array**, while one location returns an object; hourly
  arrays use Unix timestamps/GMT, mph, Fahrenheit and inches (including snowfall).
  Confirmed 16 forecast days, past-day option, rain/showers/snow as preceding-hour
  sums and sustained wind as instantaneous. Gusts are preceding-hour maxima. Confirmed
  commercial `apikey` and `customer-` host prefix. Local mocks verify both payload shapes.
- [Railway config as code](https://docs.railway.com/reference/config-as-code) and
  [monorepo root directory](https://docs.railway.com/guides/monorepo): `railway.json` with the
  Railpack builder, start command, `/api/health` check; the config file path is absolute.

These were documentation checks and mocked integrations, not live authenticated
provider calls. No live API credentials were used for these verifications.

## Executed checks

- Initial domain/spec baseline: **432 passed** (381 independent spec + 51 domain).
- Backend domain/provider/API tests after implementation: **107 passed**.
- Full `uv run pytest -q`: **487 passed, 1 failed** at that point (resolved below).
- `uv run ruff check .`: **All checks passed**.
- `uv run python manage.py check --deploy` with DEBUG=false, a temporary strong secret
  and production HTTPS settings: **no issues, 0 silenced**.
- `uv run python manage.py collectstatic --noinput`: **27 files copied, 63 post-processed**.
- Requirements exported from `uv.lock`, without dev dependencies, with hashes.
- Real `runserver --noreload` and two-worker gunicorn processes: each returned
  **200 `{"status":"ok"}`** from `/api/health` and **503 `not_configured`** from a valid
  `/api/routes/plan` request with an explicitly empty `TOMTOM_API_KEY`.
- Shared file cache: one Django process wrote an object; a separate process read it.
  Temporary smoke cache directories and server processes were cleaned up.

## Independent test conflict (resolved)

The spec suite's old unknown-miles assertion predated the coverage rule. The orchestrator
amended SPEC §6 and the test (`test_full_weather_coverage_outranks_partial_coverage`); the full
suite is green.

## Ambiguities resolved explicitly

README records the gross-weight tare assumption, partial-coverage priority,
precipitation-hour/nearest-wind mixing, gust display timing, simplified HOS, grid
coarsening precedence and continental geometry limitations. No other intentional
contract deviation was introduced. No commit, push or deployment was performed.

## Departure options (§12.1) — 2026-11-15

- `WRITE_SAMPLES=1 uv run pytest -q tests/test_frontend_contract.py`: **1 passed**;
  wrote only the new `frontend/src/mocks/backend-departures.sample.json`. Existing
  plan and heatmap samples remain byte-for-byte unchanged. The fixture includes a
  non-null suggestion and unknown coverage beyond its shortened forecast horizon.
- `uv run pytest -q`: **516 passed**; `uv run ruff check .`: **All checks passed**.
  Departure tests pin exact offset-zero scores (including subsecond departure/HOS),
  exact ETA shifts, risk-only strict comparisons/rounding, earliest/global optimum,
  headline priority, outage/horizon nulls, query validation, 404, one deduplicated
  forecast fetch, no rerouting and expiry shared with the original plan.
- Synthetic service benchmark: **0.2697 s** for 25 offsets × 3 routes × 300 checkpoints
  with 408-hour forecasts. Includes plan-cache read, scoring and result-cache write;
  provider fetch mocked, all weather selection and risk/scoring functions real.
- Live check: started a separate `uv run python manage.py runserver 8002 --noreload`
  with local credentials. Dallas (32.7767, −96.797) → Denver (39.7392, −104.9903),
  departure `2026-11-15T23:00:00Z`, 35,000 lb, 10 mi spacing, HOS on. Planning:
  **200 in 15.6302 s**, 3 routes with **90/81/90 checkpoints**, no warnings.
  Departure options: **200 in 0.1441 s**, 25 options, full base coverage, and all
  offset-zero scores exactly equal to the plan. Suggestion: **null** (no strictly
  better risk key than the base recommendation, Route B). Repeated cached request:
  **0.0058 s**, identical payload.
- Stopped only the newly started :8002 server; verified :8002 closed and the existing
  :8000 server still listening. Django emitted the pre-existing relative cache-path
  warning on startup; the API checks above succeeded.
