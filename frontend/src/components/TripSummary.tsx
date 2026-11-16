import type { TripDraft } from "../lib/form";
import { formatLoadLbs, formatTripWhen, parseLoadLbs, shortPlace } from "../lib/format";

export function TripSummary({
  draft,
  onEdit,
  onShare,
  onPrint,
  busy = false,
}: {
  draft: TripDraft;
  onEdit?: () => void;
  onShare?: () => void;
  onPrint?: () => void;
  busy?: boolean;
}) {
  const load = parseLoadLbs(draft.loadText);
  const origin = shortPlace(draft.origin?.label ?? "Origin");
  const destination = shortPlace(draft.destination?.label ?? "Destination");
  return (
    <div className="trip-summary" data-testid="trip-summary">
      <div>
        <p className="trip-route">{`${origin} → ${destination}`}</p>
        <p className="trip-meta">
          {formatTripWhen(draft.departureLocal)} · {formatLoadLbs(load ?? 0)} · every {draft.interval} mi
        </p>
      </div>
      {busy ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <div className="trip-summary-actions">
          {onPrint && (
            <button
              type="button"
              className="summary-icon-btn"
              onClick={onPrint}
              aria-label="Print a driver briefing"
              title="Print a driver briefing (P)"
            >
              <PrintGlyph />
            </button>
          )}
          {onShare && (
            <button
              type="button"
              className="summary-icon-btn"
              onClick={onShare}
              aria-label="Copy a link to this trip"
              title="Copy a link to this trip (S)"
            >
              <ShareGlyph />
            </button>
          )}
          <button type="button" onClick={onEdit}>
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

function ShareGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.6 9.4a3 3 0 0 0 4.3 0l2.2-2.2a3 3 0 0 0-4.3-4.3l-.9.9M9.4 6.6a3 3 0 0 0-4.3 0L2.9 8.8a3 3 0 0 0 4.3 4.3l.9-.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PrintGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
