const LEVELS = [
  { label: "Low", className: "swatch-low" },
  { label: "Moderate", className: "swatch-moderate" },
  { label: "High", className: "swatch-high" },
  { label: "Severe", className: "swatch-severe" },
  { label: "No Travel", className: "swatch-halt" },
  { label: "Unknown", className: "swatch-unknown" },
];

export function Legend() {
  return (
    <ul className="legend" aria-label="Risk levels">
      {LEVELS.map((level) => (
        <li key={level.label}>
          <span className={level.className} aria-hidden="true" />
          {level.label}
        </li>
      ))}
    </ul>
  );
}

export function EmptyState() {
  return (
    <div className="empty">
      <h2>No trip planned</h2>
      <p>Choose an origin, a destination, and a departure. Spotter will score three routes by weather and time.</p>
    </div>
  );
}

export function RouteSkeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <p>Scoring routes…</p>
      <span />
      <span />
      <span />
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

export function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-note" role="alert">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
