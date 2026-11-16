import { useEffect, useState, type CSSProperties } from "react";
import type { HeatVariable } from "../api/types";
import { RAMPS, rampGradient, type ContinuousVariable } from "../lib/heatmap";

const LEVELS = [
  { label: "Low", className: "swatch-low" },
  { label: "Moderate", className: "swatch-moderate" },
  { label: "High", className: "swatch-high" },
  { label: "Severe", className: "swatch-severe" },
  { label: "No Travel", className: "swatch-halt" },
];

const NAMES: Record<ContinuousVariable, string> = { wind: "Wind", rain: "Rain", snow: "Snow" };

/** Adapts to the forecast variable: risk levels for Risk, a unit-labelled ramp for the rest. */
export function Legend({ variable, visible }: { variable: HeatVariable; visible: boolean }) {
  if (variable === "risk" || !visible) {
    return (
      <ul className="legend" aria-label="Risk levels">
        {LEVELS.map((level) => (
          <li key={level.label}>
            <span className={`swatch ${level.className}`} aria-hidden="true" />
            {level.label}
          </li>
        ))}
      </ul>
    );
  }
  const spec = RAMPS[variable];
  const summary = `${NAMES[variable]} scale in ${spec.unit}: ${spec.ticks.map((tick) => tick.label).join(", ")}`;
  return (
    <div className="legend legend-ramp" role="img" aria-label={summary}>
      <span className="ramp-name">{NAMES[variable]}</span>
      <span className="ramp-scale" aria-hidden="true">
        <span className="ramp-bar" style={{ background: rampGradient(variable) }} />
        {spec.ticks.map((tick) => (
          <span key={tick.value} className="ramp-tick" style={{ "--at": tick.value / spec.max } as CSSProperties}>
            {tick.label}
          </span>
        ))}
      </span>
      <span className="ramp-unit">{spec.unit}</span>
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="empty">
      <h2>Plan around the weather</h2>
      <p>
        Enter a trip to compare three truck routes. Wind, rain and snow are checked where the truck will be,
        hour by hour, and the safest route is recommended.
      </p>
    </div>
  );
}

const STAGES = [
  { after: 0, text: "Finding truck routes…" },
  { after: 2500, text: "Sampling weather along each route…" },
  { after: 6000, text: "Scoring risk and ranking the routes…" },
  { after: 12000, text: "Still working. Weather lookups can take a few seconds." },
];

/** Card-shaped placeholders sized like real cards, with progress copy that moves on a timer. */
export function RouteSkeleton() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timers = STAGES.slice(1).map((item, index) => window.setTimeout(() => setStage(index + 1), item.after));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  return (
    <div className="skeleton" id="plan-progress" tabIndex={-1} aria-busy="true">
      <p className="skeleton-note" role="status">
        {STAGES[stage].text}
      </p>
      {[0, 1, 2].map((item) => (
        <div className="skeleton-card" key={item} aria-hidden="true">
          <span className="sk sk-title" />
          <span className="sk-grid">
            <span className="sk sk-stat" />
            <span className="sk sk-stat" />
            <span className="sk sk-stat" />
          </span>
          <span className="sk sk-bar" />
        </div>
      ))}
    </div>
  );
}

export function MapSkeleton() {
  return (
    <div className="map-canvas map-skeleton" data-testid="map-skeleton" aria-busy="true" aria-label="Loading map">
      <p>Loading map…</p>
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d="M9 1.8 17 15.6H1L9 1.8zM9 7v4M9 12.8v.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
