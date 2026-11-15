import type { GeoPoint, PlanRequest } from "../api/types";
import { parseLoadLbs } from "./format";
import { departureError, localInputToOffsetIso } from "./time";
import { samePoint } from "./geo";

export interface TripDraft {
  origin: GeoPoint | null;
  destination: GeoPoint | null;
  departureLocal: string;
  loadText: string;
  interval: 10 | 25 | 50;
  hos: boolean;
}

export interface FieldErrors {
  origin?: string;
  destination?: string;
  departure?: string;
  load?: string;
}

export function validateDraft(draft: TripDraft, now = new Date()): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.origin) errors.origin = "Choose an origin.";
  if (!draft.destination) errors.destination = "Choose a destination.";
  else if (draft.origin && samePoint(draft.origin, draft.destination)) {
    errors.destination = "Origin and destination must be different.";
  }
  const departure = departureError(draft.departureLocal, now);
  if (departure) errors.departure = departure;
  const load = parseLoadLbs(draft.loadText);
  if (load == null) errors.load = "Enter a whole number of pounds.";
  else if (load > 80_000) errors.load = "Load must be 80,000 lb or less.";
  return errors;
}

export function draftIsValid(errors: FieldErrors): boolean {
  return Object.keys(errors).length === 0;
}

export function draftToRequest(draft: TripDraft): PlanRequest {
  if (!draft.origin || !draft.destination) {
    throw new Error("Trip is incomplete");
  }
  const load = parseLoadLbs(draft.loadText);
  if (load == null) throw new Error("Load is invalid");
  return {
    origin: draft.origin,
    destination: draft.destination,
    departure: localInputToOffsetIso(draft.departureLocal),
    load_lbs: load,
    interval_mi: draft.interval,
    hos: draft.hos,
  };
}
