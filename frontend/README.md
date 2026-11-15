# Headwind

Weather-aware truck routing UI. The page plans three routes, colors the selected route by checkpoint risk, and plays a 49-hour corridor forecast.

## Setup

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Copy `.env.example` to `.env.local` when you need to override the defaults.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_URL` | `http://localhost:8000` | Django origin. The client calls `/api/*` on it. |
| `VITE_USE_MOCKS` | `false` | `true` serves `src/mocks` fixtures and does not call the network. |

Demo without the API:

```bash
VITE_USE_MOCKS=true npm run dev
```

The form starts on Dallas, TX to Denver, CO, 35,000 lb, 25 mile spacing, hours of service on, departure at the next full hour.

## Scripts

- `npm run dev` — Vite
- `npm run build` / `npm run preview`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint flat config
- `npm run test` — Vitest
- `npm run e2e` — Playwright (starts Vite with mocks on port 4173; set `E2E_PORT` when that port is taken)
- `npm run fixtures` — regenerate `src/mocks/*.json` from the mock-only risk, HOS, and weather-field modules in `src/mocks/`

## Map and forecast

The map module is loaded with `React.lazy` after the shell. `MapCanvas` does not receive the hour as a prop. The timeline owns the slider and calls `setFrame`, which only uses `setPaintProperty`. The corridor fill sits under route lines and basemap labels.

Each corridor cell is one GeoJSON polygon. The 49 hourly values live on the feature as `risk`, `wind`, `rain`, and `snow` arrays. The hour is a literal index in an `at` expression (`['at', hour, ['get', variable]]`). Sliding does not call `setData`, does not fetch again, and does not re-render the map component. In dev, `window.__spotter` counts `sourceUpdates`, `paintUpdates`, `mapRenders`, and `frame` so the Playwright test can check that.

Timeline labels are relative to the real departure, not the floored forecast hour: with a 5:20 departure frame 0 reads "20 min before departure" and frame 1 "+40 min from departure". The checkpoint highlight on the selected route follows the variable (`etaHourIndex` in `src/lib/time.ts`, mirroring `planner/services/weather.py`): Wind lights the checkpoint in the nearest hour (ties later), Rain and Snow in the hour that closes the ETA, and Risk uses the precipitation rule, the frame whose hour window contains the ETA (a 14:20 ETA lights the 14:00 frame under Wind and the 15:00 frame under Rain, Snow and Risk). Only the paint expression changes with the frame.

A forecast response whose values are all null for the active variable is shown as a failed load with Retry (`heatmapCoverage` in `src/lib/heatmap.ts`); some nulls show "Forecast unavailable for part of the corridor". If the basemap style cannot load (blocked or offline) `MapCanvas` shows a map error with Retry instead of a blank surface; later tile, sprite and glyph errors are ignored.

Basemap: OpenFreeMap Dark by default and OpenFreeMap Positron in the light theme. The theme is dark unless the system asks for light or the driver picked one with the toggle (`localStorage` key `headwind-theme`). Changing theme calls `setStyle` and restores sources. That path is not the slider path.

## Design

A full-bleed map with floating panels. Tokens (colour, type scale 12/13/15/20/28, radii, shadows) are CSS variables in `src/index.css`, dark first with a `[data-theme="light"]` override. Type is Geist (variable, self-hosted through `@fontsource-variable/geist`, `font-display: swap`) with tabular numerals everywhere.

- Desktop (1024 px and up): a 392 px trip panel on the left (form, then a trip chip, the recommendation and the route cards) and a timeline card centred in the rest of the map, with the legend docked above it.
- Tablet (768 to 1023 px): a 340 px panel; the timeline spans the bottom.
- Phone (up to 767 px): the map fills the screen. A bottom dock holds the trip sheet (collapsed, half, expanded; tap, swipe or use the handle button) with the timeline pinned under it.
- Risk colours are one palette for both themes (`src/lib/riskColor.ts`, mirrored by the `--low` to `--halt` tokens). Route lines carry a dark casing so each colour keeps 3:1 on both basemaps; No Travel is also dashed on the map and hatched in bars and legends.
- Heatmap: Risk keeps the five levels. Wind, Rain and Snow use continuous colour and opacity ramps (`RAMPS` in `src/lib/heatmap.ts`) and the legend shows the same ramp with units. The fill fades in when data arrives (skipped under `prefers-reduced-motion`).
- Only the selected route shows checkpoints; the quiet routes are thin, neutral and still clickable. Hovering a route card lights that route on the map (a layer filter change, no source update).
- The large panel is a plain translucent surface; backdrop blur is limited to the small cards (timeline, legend, mast, zoom) so repaints stay cheap while sliding.

Review screenshots (mock mode, both themes, three sizes) are generated into `design-shots/`, which is git-ignored.

Framing: `fitBounds` pads by the measured size of every element marked `data-map-overlay` (trip panel, timeline, legend) and MapLibre's own controls, so the Start/End pins stay clear of them (Playwright checks 375, 768 and 1280 px). The map re-frames when those resize until the user moves it.

## API contract

`src/mocks/backend-plan.sample.json` and `backend-heatmap.sample.json` are real backend output
(see `backend/tests/test_frontend_contract.py`). `src/api/contract.test.ts` checks them against
`src/api/types.ts`, and `src/App.test.tsx` renders the app from them. Error bodies follow
`{"error":{"code","message","fields"}}` with DRF-style `fields` (lists, nested for locations).

## Mock limits

- Fixtures are three Dallas–Denver corridors (10 / 25 / 50 mile spacing) plus one 49-hour grid. Other origins and destinations warp that geometry. They are not a second routing engine.
- A load other than 35,000 lb recomputes checkpoint and cell risk from the stored weather. It does not resample the forecast.
- Hours of service off sets trip time to drive time and spaces ETAs by mile. Weather samples stay on the hours-of-service schedule.
- The fixture samples every variable from the precipitation hour (the hour that closes the ETA’s hour). The spec uses that hour for rain and snow and the nearest hour for wind. The live API may differ.
- One checkpoint on the 25 mile plan has missing weather so the unknown state is visible.

## Checks

`npm run typecheck && npm run lint && npm run test && npm run build`, then `npm run e2e`. Playwright needs Chromium (`npx playwright install chromium`).
