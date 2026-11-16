import { useState } from "react";
import type { GeoPoint } from "../api/types";
import { draftIsValid, validateDraft, type FieldErrors, type TripDraft } from "../lib/form";
import { parseLoadLbs } from "../lib/format";
import { onRadioKeyDown } from "../lib/radio";
import { nextFullHourInput } from "../lib/time";
import { PlaceCombobox } from "./PlaceCombobox";

const INTERVALS = [10, 25, 50] as const;
const DEFAULT_ORIGIN: GeoPoint = { lat: 32.7767, lon: -96.797, label: "Dallas, TX, USA" };
const DEFAULT_DESTINATION: GeoPoint = { lat: 39.7392, lon: -104.9903, label: "Denver, CO, USA" };

interface PlanFormProps {
  busy: boolean;
  serverErrors?: FieldErrors;
  onPlan: (draft: TripDraft) => void;
  search: (query: string, signal: AbortSignal) => Promise<GeoPoint[]>;
  /**
   * Replaces the departure field when `token` changes (a suggested departure was applied elsewhere),
   * so Edit shows the time that was actually planned.
   */
  departureSync?: { local: string; token: number } | null;
  /** Replaces the whole form when `token` changes (an example, recent trip or shared link was opened). */
  draftSync?: { draft: TripDraft; token: number } | null;
}

function initialDraft(): TripDraft {
  return {
    origin: DEFAULT_ORIGIN,
    destination: DEFAULT_DESTINATION,
    departureLocal: nextFullHourInput(),
    loadText: "35,000",
    interval: 25,
    hos: true,
  };
}

export function PlanForm({ busy, serverErrors, onPlan, search, departureSync, draftSync }: PlanFormProps) {
  const [draft, setDraft] = useState<TripDraft>(initialDraft);
  const [seenSync, setSeenSync] = useState(0);
  if (departureSync && departureSync.token !== seenSync) {
    setSeenSync(departureSync.token);
    setDraft((current) => ({ ...current, departureLocal: departureSync.local }));
  }
  const [seenDraft, setSeenDraft] = useState(0);
  if (draftSync && draftSync.token !== seenDraft) {
    setSeenDraft(draftSync.token);
    setDraft(draftSync.draft);
  }
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const errors = validateDraft(draft);

  function show(key: keyof FieldErrors): string | undefined {
    if (!(attempted || touched[key])) return serverErrors?.[key];
    return errors[key] ?? serverErrors?.[key];
  }

  function patch(partial: Partial<TripDraft>, field?: keyof FieldErrors) {
    setDraft((current) => ({ ...current, ...partial }));
    if (field) setTouched((current) => ({ ...current, [field]: true }));
  }

  return (
    <form
      id="trip-form"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (!draftIsValid(errors) || busy) return;
        onPlan(draft);
      }}
    >
      <div className="route-fields">
      <PlaceCombobox
        id="origin"
        label="Origin"
        value={draft.origin}
        search={search}
        error={show("origin")}
        onBlur={() => setTouched((current) => ({ ...current, origin: true }))}
        onChange={(origin) => patch({ origin }, "origin")}
      />
      <PlaceCombobox
        id="destination"
        label="Destination"
        value={draft.destination}
        search={search}
        error={show("destination")}
        onBlur={() => setTouched((current) => ({ ...current, destination: true }))}
        onChange={(destination) => patch({ destination }, "destination")}
      />
      </div>
      <div className="field">
        <label htmlFor="departure">Departure</label>
        <input
          id="departure"
          type="datetime-local"
          value={draft.departureLocal}
          aria-invalid={show("departure") ? true : undefined}
          aria-describedby={show("departure") ? "departure-error" : undefined}
          onChange={(event) => patch({ departureLocal: event.target.value })}
          onBlur={() => setTouched((current) => ({ ...current, departure: true }))}
        />
        {show("departure") ? (
          <p id="departure-error" className="field-error">
            {show("departure")}
          </p>
        ) : (
          <p className="field-hint">Local time. Default is the next full hour.</p>
        )}
      </div>
      <div className="field-row">
      <div className="field">
        <label htmlFor="load">Load weight</label>
        <div className="suffix-field">
          <input
            id="load"
            inputMode="numeric"
            autoComplete="off"
            value={draft.loadText}
            aria-invalid={show("load") ? true : undefined}
            aria-describedby="load-hint"
            onChange={(event) => patch({ loadText: event.target.value })}
            onBlur={() => {
              setTouched((current) => ({ ...current, load: true }));
              const parsed = parseLoadLbs(draft.loadText);
              if (parsed != null) patch({ loadText: parsed.toLocaleString("en-US") });
            }}
          />
          <span aria-hidden="true">lb</span>
        </div>
        <p id="load-hint" className={show("load") ? "field-error" : "field-hint"}>
          {show("load") ?? "Cargo only, up to 80,000 lb."}
        </p>
      </div>
      <fieldset className="segment">
        <legend>Checkpoint spacing</legend>
        <div role="radiogroup" aria-label="Checkpoint spacing" className="segment-row">
          {INTERVALS.map((miles, index) => (
            <button
              key={miles}
              type="button"
              role="radio"
              aria-checked={draft.interval === miles}
              tabIndex={draft.interval === miles ? 0 : -1}
              onClick={() => patch({ interval: miles })}
              onKeyDown={(event) =>
                onRadioKeyDown(event, index, INTERVALS.length, (next) => patch({ interval: INTERVALS[next] }))
              }
            >
              {miles} mi
            </button>
          ))}
        </div>
      </fieldset>
      </div>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={draft.hos}
        aria-labelledby="hos-label"
        aria-describedby="hos-hint"
        onClick={() => patch({ hos: !draft.hos })}
      >
        <span className="switch-text">
          <span id="hos-label">Hours of service</span>
          <span id="hos-hint" className="field-hint">30 min break after 8 h driving, 10 h off after 11 h. The 14 h window is not modelled.</span>
        </span>
        <span className="switch-track" aria-hidden="true" />
      </button>
      <button type="submit" className="submit" data-testid="plan-submit" disabled={!draftIsValid(errors) || busy}>
        {busy ? "Planning…" : "Plan routes"}
      </button>
      <span className="sr-only" aria-live="polite">
        {busy ? "Planning routes" : ""}
      </span>
    </form>
  );
}
