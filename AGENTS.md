# AGENTS.md — spotter (Weather-Aware Truck Routing)

Read `SPEC.md` first; it is the single source of truth (decisions, rules, API contract, module interface).

- Monorepo: `backend/` (Django 5 + DRF, uv, pytest) and `frontend/` (Vite + React + TS + MapLibre).
- Backend: `cd backend && uv run pytest` · `uv run ruff check .` · `uv run python manage.py runserver 8000`.
- Frontend: `cd frontend && npm run dev|build|lint|typecheck|test|e2e`.
- Secrets only in `backend/.env` (gitignored). `.env.example` documents every variable.
- Tests never hit the network: mock HTTP with `responses` (backend) / MSW or route mocks (frontend).
- Do not commit, push or deploy; the orchestrator does that after review.
- Stay inside the directory you were assigned. Code, identifiers and UI copy in English.
