import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ApiError } from "./api/errors";
import type { DepartureOptionsResponse, HeatmapResponse, PlanResponse } from "./api/types";
import departureFixture from "./mocks/departure-options.mock.json";
import heatmapSample from "./mocks/backend-heatmap.sample.json";
import planSample from "./mocks/backend-plan.sample.json";

const planRoutes = vi.fn();
const fetchHeatmap = vi.fn();
const fetchDepartureOptions = vi.fn();

vi.mock("./api/client", () => ({
  api: {
    health: vi.fn(async () => ({ status: "ok" })),
    geocode: vi.fn(async () => ({ results: [] })),
    planRoutes: (...args: unknown[]) => planRoutes(...args),
    fetchHeatmap: (...args: unknown[]) => fetchHeatmap(...args),
    fetchDepartureOptions: (...args: unknown[]) => fetchDepartureOptions(...args),
  },
}));
// maplibre needs WebGL; the map is covered by the Playwright suite.
vi.mock("./map/MapCanvas", () => ({ MapCanvas: () => <div data-testid="map-canvas" /> }));

beforeEach(() => {
  planRoutes.mockReset();
  fetchHeatmap.mockReset();
  fetchDepartureOptions.mockReset();
  fetchDepartureOptions.mockRejectedValue(new ApiError(404, "not_found", "Plan not found or expired."));
});

describe("App against backend payloads", () => {
  it("renders the real plan and enables the forecast slider", async () => {
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(screen.getByText(/incomplete weather coverage/i)).toBeInTheDocument();
    expect(screen.getByText(/Weather coverage 94%/)).toBeInTheDocument();
    // Incomplete coverage must read as provisional, never as the safest.
    const lead = document.querySelector(".callout-lead");
    expect(lead).toHaveTextContent(/best available pick/);
    expect(lead).toHaveTextContent(/Forecast data is incomplete for Route C \(94% covered\)/);
    // This plan's winner still crosses No Travel miles, which the copy must say.
    expect(lead).toHaveTextContent(/crosses .* of No Travel/);
    expect(lead).not.toHaveTextContent(/safest|full forecast/i);
    await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
    expect(fetchHeatmap).toHaveBeenCalledWith(planSample.plan_id, expect.any(AbortSignal));
  });

  it("explains a 503 not_configured without a pointless retry", async () => {
    planRoutes.mockRejectedValue(
      new ApiError(503, "not_configured", "Routing is not configured. Set TOMTOM_API_KEY on the server."),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not available yet/i);
    expect(alert).not.toHaveTextContent("TOMTOM");
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows nested DRF validation errors on the right fields instead of crashing", async () => {
    planRoutes.mockRejectedValue(
      new ApiError(400, "validation_error", "Invalid request.", {
        origin: { lat: ["Ensure this value is less than or equal to 90."] },
        departure: ["Departure must be between one hour ago and 14 days ahead."],
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    await waitFor(() => expect(screen.getAllByText(/Departure must be between/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/less than or equal to 90/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a retry after a network failure", async () => {
    planRoutes.mockRejectedValueOnce(new ApiError(0, "network_error", "The routing service could not be reached."));
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
  });

  it("keeps the plan when only the forecast fails and lets the user retry it", async () => {
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockRejectedValueOnce(new ApiError(404, "not_found", "Plan is unknown or expired."));
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
    await user.click(await screen.findByRole("button", { name: "Retry forecast" }));
    await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
  });

  it("moves focus to the recommended route after planning and back to the form on Edit", async () => {
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    const recommended = (await screen.findAllByTestId("route-card")).find((card) => card.dataset.recommended === "true");
    await waitFor(() => expect(within(recommended as HTMLElement).getByRole("button", { name: /Route/ })).toHaveFocus());
    expect(screen.getByText(/3 routes scored\. Top pick: Route \w\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Origin" })).toHaveFocus());
  });

  function withValues(fill: (row: (number | null)[], index: number) => (number | null)[]): HeatmapResponse {
    const base = heatmapSample as unknown as HeatmapResponse;
    const map = (rows: (number | null)[][]) => rows.map(fill);
    return { ...base, risk: map(base.risk), wind: map(base.wind), rain: map(base.rain), snow: map(base.snow) };
  }

  it("treats a heatmap whose values are all null as a failed forecast with a working Retry", async () => {
    const allNull = withValues((row) => row.map(() => null));
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValueOnce(allNull);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
    const retry = await screen.findByRole("button", { name: "Retry forecast" });
    expect(screen.getByTestId("forecast-clock")).toHaveTextContent(/Forecast unavailable/);
    expect(screen.getByTestId("heatmap-slider")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play forecast" })).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
    expect(fetchHeatmap).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry forecast" })).toBeNull();
  });

  it("warns, but stays usable, when only part of the corridor has a forecast", async () => {
    // The sample already has hours without data; it must read as ready plus a small warning.
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
    expect(screen.getByText("Forecast unavailable for part of the corridor")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry forecast" })).toBeNull();
  });

  it("shows no warning when every cell has data", async () => {
    const full = withValues((row) => row.map(() => 1));
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(full);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
    expect(screen.queryByText(/part of the corridor/)).toBeNull();
  });

  it("only flags the variable that has no values, and recovers when another is chosen", async () => {
    const base = heatmapSample as unknown as HeatmapResponse;
    const noRain: HeatmapResponse = { ...base, rain: base.rain.map((row) => row.map(() => null)) };
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(noRain);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
    await user.click(screen.getByRole("radio", { name: "Rain" }));
    expect(screen.getByRole("button", { name: "Retry forecast" })).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-slider")).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Wind" }));
    expect(screen.getByTestId("heatmap-slider")).toBeEnabled();
  });

  describe("best time to leave", () => {
    const full = (departureFixture as unknown as Record<string, DepartureOptionsResponse>).c0ffee25;
    // The fixture keeps a second day for the demo; the contract is 25 hourly options.
    const options = { ...full, options: full.options.slice(0, 25) };

    it("never blocks the plan: a failure is a quiet inline retry that works", async () => {
      planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
      fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
      fetchDepartureOptions.mockRejectedValueOnce(new ApiError(502, "upstream_error", "Weather service is down."));
      fetchDepartureOptions.mockResolvedValue({ ...options, plan_id: planSample.plan_id });
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Plan routes" }));
      expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
      const strip = await screen.findByRole("region", { name: "Best time to leave" });
      expect(await within(strip).findByText(/Weather service is down/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("heatmap-slider")).toBeEnabled());
      await user.click(within(strip).getByRole("button", { name: "Retry" }));
      expect(await screen.findAllByTestId("departure-bar")).toHaveLength(25);
      expect(fetchDepartureOptions).toHaveBeenCalledWith(planSample.plan_id, expect.any(AbortSignal));
    });

    it("applies the suggestion by planning the same trip at the suggested departure", async () => {
      planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
      fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
      fetchDepartureOptions.mockResolvedValue({ ...options, plan_id: planSample.plan_id });
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Plan routes" }));
      await user.click(await screen.findByTestId("apply-suggestion"));
      await waitFor(() => expect(planRoutes).toHaveBeenCalledTimes(2));
      const [first] = planRoutes.mock.calls[0] as [{ departure: string }];
      const [second] = planRoutes.mock.calls[1] as [typeof first & Record<string, unknown>];
      expect(Date.parse(second.departure)).toBe(Date.parse(options.suggestion!.departure));
      expect({ ...second, departure: "" }).toEqual({ ...first, departure: "" });
      // The form shows the time that was planned, not the one before.
      await user.click(await screen.findByRole("button", { name: "Edit" }));
      const planned = new Date(options.suggestion!.departure);
      const pad = (value: number) => String(value).padStart(2, "0");
      const local = `${planned.getFullYear()}-${pad(planned.getMonth() + 1)}-${pad(planned.getDate())}T${pad(planned.getHours())}:${pad(planned.getMinutes())}`;
      expect(screen.getByLabelText("Departure")).toHaveValue(local);
    });
  });
});

describe("App as a product: shared links, examples and recent trips", () => {
  it("opens a shared link straight into its plan and keeps the link in the address bar", async () => {
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    window.history.replaceState(
      null,
      "",
      "/?from=37.80440,-122.27120,Oakland, CA, USA&to=39.52960,-119.81380,Reno, NV, USA&at=2099-01-01T08:00&load=42000&every=10&hos=1",
    );
    render(<App />);
    expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
    const request = planRoutes.mock.calls[0][0];
    expect(request.origin).toMatchObject({ lat: 37.8044, lon: -122.2712, label: "Oakland, CA, USA" });
    expect(request.destination.label).toBe("Reno, NV, USA");
    expect(request).toMatchObject({ load_lbs: 42000, interval_mi: 10, hos: true });
    expect(window.location.search).toContain("from=");
  });

  it("plans an example in one click and lists it under recent trips next time", async () => {
    planRoutes.mockResolvedValue(planSample as unknown as PlanResponse);
    fetchHeatmap.mockResolvedValue(heatmapSample as unknown as HeatmapResponse);
    const user = userEvent.setup();
    const first = render(<App />);
    await user.click(screen.getByRole("button", { name: /Chicago → Nashville/ }));
    expect(await screen.findAllByTestId("route-card")).toHaveLength(3);
    expect(planRoutes.mock.calls[0][0].destination.label).toBe("Nashville, TN, USA");
    first.unmount();
    window.history.replaceState(null, "", "/");
    render(<App />);
    const recent = screen.getByRole("region", { name: "Recent trips" });
    expect(within(recent).getByRole("button", { name: /Chicago → Nashville/ })).toBeInTheDocument();
  });
});
