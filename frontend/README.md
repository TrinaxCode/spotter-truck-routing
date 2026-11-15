# Spotter dispatch console

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
- `npm run e2e` — Playwright (starts Vite with mocks on port 4173)
- `npm run fixtures` — regenerate `src/mocks/*.json` from the mock-only risk, HOS, and weather-field modules in `src/mocks/`

## Map and forecast

The map module is loaded with `React.lazy` after the shell. `MapCanvas` does not receive the hour as a prop. The timeline owns the slider and calls `setFrame`, which only uses `setPaintProperty`. The corridor fill sits under route lines and basemap labels.

Each corridor cell is one GeoJSON polygon. The 49 hourly values live on the feature as `risk`, `wind`, `rain`, and `snow` arrays. The hour is a literal index in an `at` expression (`['at', hour, ['get', variable]]`). Sliding does not call `setData`, does not fetch again, and does not re-render the map component. In dev, `window.__spotter` counts `sourceUpdates`, `paintUpdates`, `mapRenders`, and `frame` so the Playwright test can check that.

Basemap: OpenFreeMap Positron in light mode and OpenFreeMap Dark in dark mode. Theme is stored in `localStorage` (`spotter-theme`). Changing theme calls `setStyle` and restores sources. That path is not the slider path.

## Mock limits

- Fixtures are three Dallas–Denver corridors (10 / 25 / 50 mile spacing) plus one 49-hour grid. Other origins and destinations warp that geometry. They are not a second routing engine.
- A load other than 35,000 lb recomputes checkpoint and cell risk from the stored weather. It does not resample the forecast.
- Hours of service off sets trip time to drive time and spaces ETAs by mile. Weather samples stay on the hours-of-service schedule.
- The fixture samples every variable from the precipitation hour (the hour that closes the ETA’s hour). The spec uses that hour for rain and snow and the nearest hour for wind. The live API may differ.
- One checkpoint on the 25 mile plan has missing weather so the unknown state is visible.

## Checks

`npm run typecheck && npm run lint && npm run test && npm run build`, then `npm run e2e`. Playwright needs Chromium (`npx playwright install chromium`).
