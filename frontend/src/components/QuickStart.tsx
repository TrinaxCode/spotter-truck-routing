import { formatLoadLbs, shortPlace } from "../lib/format";
import { EXAMPLE_TRIPS, type TripTemplate } from "../lib/trips";

interface QuickStartProps {
  recent: TripTemplate[];
  disabled: boolean;
  onPick: (trip: TripTemplate) => void;
}

/** One-click starters under the form: the user's recent trips, then curated examples. */
export function QuickStart({ recent, disabled, onPick }: QuickStartProps) {
  return (
    <div className="quick" data-testid="quick-start">
      {recent.length > 0 && (
        <section aria-labelledby="recent-title">
          <h2 id="recent-title" className="section-title">
            Recent trips
          </h2>
          <ul className="recent-list">
            {recent.map((trip) => (
              <li key={`${trip.origin.label}|${trip.destination.label}`}>
                <button type="button" className="recent-item" disabled={disabled} onClick={() => onPick(trip)}>
                  <RecentGlyph />
                  <span className="recent-text">
                    <strong>
                      {shortPlace(trip.origin.label)} → {shortPlace(trip.destination.label)}
                    </strong>
                    <small>
                      {formatLoadLbs(trip.loadLbs)} · every {trip.interval} mi
                    </small>
                  </span>
                  <span className="recent-go" aria-hidden="true">
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="examples-title">
        <h2 id="examples-title" className="section-title">
          Try an example
        </h2>
        <ul className="example-grid">
          {EXAMPLE_TRIPS.map((example) => (
            <li key={example.title}>
              <button type="button" className="example-card" disabled={disabled} onClick={() => onPick(example.trip)}>
                <strong>{example.title}</strong>
                <small>{example.note}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function RecentGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="recent-icon">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
