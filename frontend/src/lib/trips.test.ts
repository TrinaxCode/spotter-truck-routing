import { describe, expect, it } from "vitest";
import {
  EXAMPLE_TRIPS,
  draftToSearch,
  loadRecentTrips,
  rememberTrip,
  searchToDraft,
  templateToDraft,
  type TripTemplate,
} from "./trips";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const dallas = EXAMPLE_TRIPS[0].trip;

describe("shareable trip links", () => {
  it("round-trips a draft through the query string, labels with commas included", () => {
    const draft = templateToDraft(dallas, "2026-11-16T08:00");
    const search = draftToSearch(draft);
    const back = searchToDraft(search, new Date("2026-11-15T12:00:00"));
    expect(back).toEqual(draft);
    expect(back?.origin?.label).toBe("Dallas, TX, USA");
  });

  it("moves a departure that has already passed to the next full hour", () => {
    const search = draftToSearch(templateToDraft(dallas, "2026-01-01T08:00"));
    const back = searchToDraft(search, new Date("2026-11-15T12:20:00"));
    expect(back?.departureLocal).toBe("2026-11-15T13:00");
  });

  it("rejects links with missing or out-of-range places and loads", () => {
    expect(searchToDraft("?to=1,2,x&load=1000")).toBeNull();
    expect(searchToDraft("?from=95,0,x&to=1,2,y&load=1000")).toBeNull();
    expect(searchToDraft("?from=1,2,x&to=3,4,y&load=90000")).toBeNull();
  });

  it("falls back to 25 mi spacing for an unknown interval", () => {
    const back = searchToDraft("?from=1,2,a&to=3,4,b&load=1000&every=7", new Date("2026-11-15T12:00:00"));
    expect(back?.interval).toBe(25);
  });
});

describe("recent trips", () => {
  it("keeps the newest first, without duplicates, at most four", () => {
    const storage = memoryStorage();
    const trips = EXAMPLE_TRIPS.map((example) => example.trip);
    for (const trip of trips) rememberTrip(trip, storage);
    rememberTrip(trips[1], storage);
    const recent = loadRecentTrips(storage);
    expect(recent).toHaveLength(4);
    expect(recent[0]).toEqual(trips[1]);
    expect(recent.filter((trip) => trip.origin.label === trips[1].origin.label)).toHaveLength(1);
  });

  it("ignores corrupt or foreign data", () => {
    const storage = memoryStorage();
    storage.setItem("headwind-recent-trips", "{not json");
    expect(loadRecentTrips(storage)).toEqual([]);
    storage.setItem("headwind-recent-trips", JSON.stringify([{ origin: 1 }, dallas as TripTemplate]));
    expect(loadRecentTrips(storage)).toEqual([dallas]);
  });
});
