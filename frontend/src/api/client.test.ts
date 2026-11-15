import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";
import { ApiError } from "./errors";
import { nextFullHourInput, localInputToOffsetIso } from "../lib/time";

const dallas = { lat: 32.7767, lon: -96.797, label: "Dallas, TX, USA" };
const denver = { lat: 39.7392, lon: -104.9903, label: "Denver, CO, USA" };

function planBody() {
  return {
    origin: dallas,
    destination: denver,
    departure: localInputToOffsetIso(nextFullHourInput()),
    load_lbs: 35000,
    interval_mi: 25 as const,
    hos: true,
  };
}

describe("api client", () => {
  it("posts a plan and reads an error envelope", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://localhost:8000/api/routes/plan");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({ error: { code: "validation_error", message: "Bad load", fields: { load_lbs: "no" } } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = createApiClient({ useMocks: false, fetchFn, baseUrl: "http://localhost:8000" });
    await expect(client.planRoutes(planBody())).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
      fields: { load_lbs: "no" },
    });
  });

  it("turns a failed fetch into a network error and lets abort through", async () => {
    const client = createApiClient({
      useMocks: false,
      fetchFn: vi.fn(async () => {
        throw new TypeError("offline");
      }),
    });
    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
    await expect(client.health()).rejects.toMatchObject({ code: "network_error", status: 0 });

    const aborting = createApiClient({
      useMocks: false,
      fetchFn: vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    });
    await expect(aborting.geocode("Dallas")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("serves the Dallas to Denver fixtures without the network", async () => {
    const fetchFn = vi.fn();
    const client = createApiClient({ useMocks: true, mockDelayMs: 0, fetchFn });
    const plan = await client.planRoutes(planBody());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(plan.routes).toHaveLength(3);
    expect(plan.routes.filter((route) => route.recommended)).toHaveLength(1);
    expect(plan.recommended_route_id).toBe(plan.routes.find((route) => route.rank === 1)?.id);
    const heat = await client.fetchHeatmap(plan.plan_id);
    expect(heat.hours).toBe(49);
    expect(heat.risk).toHaveLength(heat.cells.length);
    expect(heat.risk[0]).toHaveLength(49);
    await expect(client.fetchHeatmap("missing")).rejects.toMatchObject({ status: 404, code: "not_found" });
    const places = await client.geocode("ama");
    expect(places.results[0]?.label).toMatch(/Amarillo/);
    expect((await client.geocode("x")).results).toEqual([]);
  });
});
