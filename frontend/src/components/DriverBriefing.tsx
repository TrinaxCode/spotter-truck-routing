import { createPortal } from "react-dom";
import type { PlanResponse, RouteOption } from "../api/types";
import {
  formatAvgRisk,
  formatClock,
  formatDuration,
  formatInchesPerHour,
  formatLoadLbs,
  formatMiles,
  formatSpeedMph,
  formatTempF,
} from "../lib/format";
import { milesByLevelLabel, riskColor, riskLabel } from "../lib/riskColor";

interface DriverBriefingProps {
  plan: PlanResponse;
  route: RouteOption;
  origin: string;
  destination: string;
}

/**
 * Print-only trip sheet for the cab: the decision, every route side by side and the selected
 * route's checkpoint log. It lives at the end of <body> and is hidden on screen; `@media print`
 * hides the app and shows only this, so "Print briefing" (or Save as PDF) gives a clean document.
 */
export function DriverBriefing({ plan, route, origin, destination }: DriverBriefingProps) {
  if (typeof document === "undefined") return null;
  const ranked = [...plan.routes].sort((a, b) => a.rank - b.rank);
  const recommended = plan.routes.find((item) => item.recommended);
  return createPortal(
    <article className="briefing" aria-hidden="true">
      <header className="briefing-head">
        <div>
          <p className="briefing-kicker">Driver briefing</p>
          <h1>
            {origin} → {destination}
          </h1>
          <p>
            Departs {formatClock(route.departure)} · {formatLoadLbs(plan.request.load_lbs)} cargo · checkpoints every{" "}
            {plan.request.interval_mi} mi · HOS breaks {plan.request.hos ? "included" : "off"}
          </p>
        </div>
        <p className="briefing-stamp">Generated {formatClock(plan.generated_at)}</p>
      </header>

      <section>
        <h2>Recommendation</h2>
        <p className="briefing-lead">
          {recommended ? `${recommended.label} is ranked first.` : "No route is ranked first."}{" "}
          {plan.recommendation.explanation.join(" ")}
        </p>
        {plan.warnings.length > 0 && (
          <ul className="briefing-warnings">
            {plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Routes compared</h2>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Route</th>
              <th>Distance</th>
              <th>Drive</th>
              <th>Total incl. breaks</th>
              <th>Arrival</th>
              <th>Worst</th>
              <th>Avg risk</th>
              <th>Miles by level</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((item) => (
              <tr key={item.id} data-selected={item.id === route.id}>
                <td>{item.rank}</td>
                <td>{item.label}</td>
                <td>{formatMiles(item.distance_mi)}</td>
                <td>{formatDuration(item.drive_time_s)}</td>
                <td>{formatDuration(item.total_time_s)}</td>
                <td>{formatClock(item.arrival)}</td>
                <td>
                  <Level level={item.summary.max_level} />
                </td>
                <td>{formatAvgRisk(item.summary.avg_risk)}</td>
                <td>{milesByLevelLabel(item.summary.miles_by_level)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {route.summary.breaks.length > 0 && (
        <section>
          <h2>Hours-of-service stops on {route.label}</h2>
          <ul className="briefing-stops">
            {route.summary.breaks.map((item) => (
              <li key={item.start}>
                {item.type === "rest_10h" ? "10-hour rest" : "30-minute break"} at mile {Math.round(item.at_mile)} ·{" "}
                {formatClock(item.start)} to {formatClock(item.end)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Checkpoint log · {route.label}</h2>
        <table className="briefing-log">
          <thead>
            <tr>
              <th>Mile</th>
              <th>ETA</th>
              <th>Risk</th>
              <th>Wind (gust)</th>
              <th>Rain</th>
              <th>Snow</th>
              <th>Temp</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {route.checkpoints.map((checkpoint) => (
              <tr key={checkpoint.index}>
                <td>{Math.round(checkpoint.mile)}</td>
                <td>{formatClock(checkpoint.eta)}</td>
                <td>
                  <Level level={checkpoint.level} />
                </td>
                <td>
                  {checkpoint.weather
                    ? `${formatSpeedMph(checkpoint.weather.wind_mph)} (${formatSpeedMph(checkpoint.weather.gust_mph)})`
                    : "—"}
                </td>
                <td>{checkpoint.weather ? formatInchesPerHour(checkpoint.weather.rain_in_hr) : "—"}</td>
                <td>{checkpoint.weather ? formatInchesPerHour(checkpoint.weather.snow_in_hr) : "—"}</td>
                <td>{checkpoint.weather ? formatTempF(checkpoint.weather.temp_f) : "—"}</td>
                <td>{checkpoint.reasons.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="briefing-foot">
        Risk uses sustained wind, rain and snow at each checkpoint's ETA with the cargo load rules. Forecasts change;
        re-plan before departure.
      </footer>
    </article>,
    document.body,
  );
}

function Level({ level }: { level: number | null }) {
  return (
    <span className="briefing-level">
      <span className="briefing-dot" style={{ background: riskColor(level) }} />
      {riskLabel(level)}
    </span>
  );
}
