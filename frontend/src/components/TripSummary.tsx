import type { TripDraft } from "../lib/form";
import { formatTripSummary, parseLoadLbs } from "../lib/format";

export function TripSummary({ draft, onEdit }: { draft: TripDraft; onEdit: () => void }) {
  const load = parseLoadLbs(draft.loadText);
  const line = formatTripSummary({
    origin: draft.origin?.label ?? "Origin",
    destination: draft.destination?.label ?? "Destination",
    departureLocal: draft.departureLocal,
    loadLbs: load ?? 0,
    intervalMi: draft.interval,
  });
  return (
    <div className="trip-summary" data-testid="trip-summary">
      <p>{line}</p>
      <button type="button" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}
