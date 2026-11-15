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
