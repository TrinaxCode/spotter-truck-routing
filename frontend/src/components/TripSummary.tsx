import type { TripDraft } from "../lib/form";
import { formatLoadLbs, formatTripWhen, parseLoadLbs, shortPlace } from "../lib/format";

export function TripSummary({
  draft,
  onEdit,
  busy = false,
}: {
  draft: TripDraft;
  onEdit?: () => void;
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
        <button type="button" onClick={onEdit}>
          Edit
        </button>
      )}
    </div>
  );
}
