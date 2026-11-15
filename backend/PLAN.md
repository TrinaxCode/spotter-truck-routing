# Backend implementation plan

Goal: implement SPEC sections 3–8 and the exact section 11 public interfaces.
Scope: backend only; tests/spec is owned by another agent. No git mutations or deployments.

Architecture: pure risk, sampling, HOS and recommendation modules; provider adapters
normalize HTTP data; the planner orchestrates and persists plans in the shared file
cache. DRF validates input and maps typed service errors to the JSON API contract.

1. Domain: write boundary, geometry, HOS, scoring and tie-break tests; run red;
   implement services/risk.py, sampling.py, hos.py and recommend.py; run green.
2. Providers: write mocked HTTP tests using complete fixtures for TomTom and
   Open-Meteo, including malformed responses, retries, units and missing hours;
   implement HTTP, routing, geocode, weather; run green.
3. API: write validation, plan integration and heatmap tests, run red; implement
   serializers, views, URLs, orchestration, corridor grid and shared caching.
4. Delivery: document verified upstream contracts and ambiguities; export locked
   production requirements; supply Render service and environment example.
5. Verify: full pytest (including independently owned spec tests if present), Ruff,
   Django checks, production collectstatic and gunicorn health/not-configured smoke.

Acceptance: every risk/load boundary and ranking criterion pinned; no live HTTP
in tests; 49 heatmap frames with at most 300 cells; missing weather remains unknown;
all upstream errors sanitized; keyless planning returns 503; no fake routes.

## SPEC §12.1 — Departure options

Implement inline in the assigned backend; do not commit or edit frontend except the
new contract sample. Root README gets only the two explicitly requested additions.

1. Add failing departure tests: 25 offsets, exact offset-zero plan scores, shifted
   checkpoint ETAs including HOS and subsecond precision, missing forecasts, validation,
   404, one deduplicated weather fetch, no routing, cache reuse and plan expiry.
2. Persist private ETA offsets and expiry in `planner.py` without changing the public
   plan payload. Implement `departures.py` using the existing weather/risk/owned-mile/
   scoring/ranking functions; compare `ranking_key(score)[:-1]`, earliest tie, strict
   improvement only. Headline priority: No Travel, Severe, High, average risk.
3. Register the serializer/view/URL, run the departure tests, extend the existing
   contract test and write only `backend-departures.sample.json` with WRITE_SAMPLES=1.
4. Measure 25 × 3 × 300 checkpoint scoring with a full 408-hour forecast and mocked
   provider boundary; document API, fixed-traffic assumption and measured evidence.
5. Run full pytest/Ruff; start a private `runserver 8002 --noreload`, plan Dallas→Denver,
   time the new endpoint and inspect its suggestion, then stop only that server.
