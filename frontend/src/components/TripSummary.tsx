import type { TripDraft } from "../lib/form";
import { formatLoadLbs, formatTripWhen, parseLoadLbs, shortPlace } from "../lib/format";

export function TripSummary({
  draft,
  onEdit,
  onShare,
  busy = false,
}: {
  draft: TripDraft;
  onEdit?: () => void;
  onShare?: () => void;
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
          {onShare && (
            <button type="button" className="icon-text-btn" onClick={onShare} aria-label="Copy a link to this trip">
              <ShareGlyph />
              Share
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
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
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
