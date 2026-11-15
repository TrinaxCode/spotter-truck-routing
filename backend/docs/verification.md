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
- [Render Blueprint](https://render.com/docs/blueprint-spec),
  [Python version selection](https://render.com/docs/python-version) and
  [persistent disks](https://render.com/docs/disks): verified rootDir, custom Blueprint
  path, autoDeployTrigger, service disk support and single-instance limitation.

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
