- [~] Domain: coverage correction implemented; legacy spec unknown-ranking test conflicts with review.
- [x] Providers: official docs reviewed; mocked HTTP, batching/cache/retry tests pass.
- [x] API: validation, orchestration, HOS and 49-frame heatmap integration tests pass.
- [x] Delivery: environment example, Render, locked requirements, README and verification note.
- [~] Verification: Ruff, Django deploy checks, collectstatic, runserver/gunicorn and shared-cache
  smoke pass. Full pytest has one incompatible independent spec assertion; owner update pending.

## Departure options (§12.1)

- [x] Add regression tests and preserve exact checkpoint ETA offsets privately in cached plans.
- [x] Implement 25 departure scores, risk-only suggestion and serializer/API/cache integration.
- [x] Generate the departure contract sample; document API and fixed-traffic decision.
- [x] Measure 25 × 3 × 300 scoring (0.2697 s); full pytest (516 passed), Ruff clean;
  live Dallas→Denver on :8002 (144.1 ms, suggestion null), then stop :8002; :8000 intact.
