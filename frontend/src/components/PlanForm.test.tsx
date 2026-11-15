import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import type { GeoPoint } from "../api/types";
import { HeatmapBar } from "./HeatmapBar";
import { PlanForm } from "./PlanForm";
import { PlaceCombobox } from "./PlaceCombobox";
import { RouteCard } from "./RouteList";
import type { RouteOption } from "../api/types";

const search = vi.fn(async (): Promise<GeoPoint[]> => []);

describe("PlanForm", () => {
  it("submits the Dallas to Denver defaults", async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn();
    render(<PlanForm busy={false} search={search} onPlan={onPlan} />);
    expect(screen.getByRole("combobox", { name: "Origin" })).toHaveValue("Dallas, TX, USA");
    expect(screen.getByRole("combobox", { name: "Destination" })).toHaveValue("Denver, CO, USA");
    await user.click(screen.getByRole("button", { name: "Plan routes" }));
    expect(onPlan).toHaveBeenCalledWith(
      expect.objectContaining({ interval: 25, hos: true, loadText: "35,000" }),
    );
  });

  it("shows a field error and disables submit when the origin is cleared", async () => {
    const user = userEvent.setup();
    render(<PlanForm busy={false} search={search} onPlan={vi.fn()} />);
    await user.clear(screen.getByRole("combobox", { name: "Origin" }));
    expect(screen.getByText("Choose an origin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan routes" })).toBeDisabled();
  });

  it("changes the checkpoint interval", async () => {
    const user = userEvent.setup();
    render(<PlanForm busy={false} search={search} onPlan={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "10 mi" }));
    expect(screen.getByRole("radio", { name: "10 mi" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("PlaceCombobox", () => {
  it("debounces a search and selects with the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const lookup = vi.fn(async (query: string) => {
      if (query.toLowerCase().includes("ama")) {
        return [{ label: "Amarillo, TX, USA", lat: 35.222, lon: -101.8313 }];
      }
      return [];
    });
    render(
      <PlaceCombobox id="origin" label="Origin" value={null} onChange={onChange} search={lookup} />,
    );
    await user.type(screen.getByRole("combobox", { name: "Origin" }), "Ama");
    expect(await screen.findByRole("option", { name: "Amarillo, TX, USA" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: "Amarillo, TX, USA" }));
    expect(lookup).toHaveBeenCalled();
  });
});

describe("RouteCard", () => {
  it("shows the recommended badge, break sentence, and miles label", () => {
    const route = {
      id: "r1",
      label: "Route A",
      rank: 1,
      recommended: true,
      geometry: { type: "LineString", coordinates: [[-96, 32], [-104, 39]] },
      distance_mi: 100,
      drive_time_s: 3600,
      total_time_s: 5400,
      departure: "2026-11-16T14:00:00Z",
      arrival: "2026-11-16T15:30:00Z",
      summary: {
        miles_by_level: { low: 75, moderate: 0, high: 0, severe: 0, no_travel: 25, unknown: 0 },
        avg_risk: 1,
        max_level: 4,
        weather_coverage: 1,
        checkpoint_count: 1,
        breaks: [{ type: "break_30m", at_mile: 40, start: "2026-11-16T14:00:00Z", end: "2026-11-16T14:30:00Z" }],
      },
      checkpoints: [],
    } satisfies RouteOption;
    render(
      <ul>
        <RouteCard
          route={route}
          selected
          explanation={["Fewer severe miles than Route C."]}
          onSelect={vi.fn()}
          onInspect={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("1 HOS break")).toBeInTheDocument();
    expect(screen.getByText(/Total 1 hr 30 min incl\. breaks/)).toBeInTheDocument();
    expect(screen.getByText("Arrival")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /No Travel 25 mi/ })).toBeInTheDocument();
    expect(screen.getByText("Fewer severe miles than Route C.")).toBeInTheDocument();
  });

  it("warns when weather coverage is incomplete", () => {
    const route = {
      id: "r2",
      label: "Route B",
      rank: 2,
      recommended: false,
      geometry: { type: "LineString", coordinates: [[-96, 32], [-104, 39]] },
      distance_mi: 100,
      drive_time_s: 7200,
      total_time_s: 7200,
      departure: "2026-11-16T14:00:00Z",
      arrival: "2026-11-16T16:00:00Z",
      summary: {
        miles_by_level: { low: 80, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 20 },
        avg_risk: 0,
        max_level: 0,
        weather_coverage: 0.8,
        checkpoint_count: 2,
        breaks: [
          { type: "break_30m", at_mile: 40, start: "2026-11-16T15:00:00Z", end: "2026-11-16T15:30:00Z" },
          { type: "rest_10h", at_mile: 80, start: "2026-11-16T16:00:00Z", end: "2026-11-17T02:00:00Z" },
        ],
      },
      checkpoints: [],
    } satisfies RouteOption;
    render(
      <ul>
        <RouteCard route={route} selected={false} explanation={[]} onSelect={vi.fn()} onInspect={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText("2 HOS breaks")).toBeInTheDocument();
    expect(screen.getByText(/Weather coverage 80%/)).toBeInTheDocument();
  });
});

describe("HeatmapBar", () => {
  it("reports the hour without asking the parent to rebuild data", async () => {
    const user = userEvent.setup();
    const onFrame = vi.fn();
    render(
      <HeatmapBar
        startIso="2026-11-16T14:00:00Z"
        status="ready"
        onRetry={vi.fn()}
        onFrame={onFrame}
      />,
    );
    expect(onFrame).toHaveBeenCalledWith(0, "risk", true);
    fireEvent.change(screen.getByRole("slider", { name: /Forecast hour/ }), { target: { value: "4" } });
    expect(onFrame).toHaveBeenCalledWith(4, "risk", true);
    await user.click(screen.getByRole("radio", { name: "Wind" }));
    expect(onFrame).toHaveBeenCalledWith(4, "wind", true);
  });
});

describe("keyboard and async behaviour", () => {
  it("moves selection and focus together with the arrow keys and uses a roving tab stop", async () => {
    const user = userEvent.setup();
    render(<PlanForm busy={false} search={search} onPlan={vi.fn()} />);
    const radios = screen.getAllByRole("radio", { name: /mi$/ });
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    radios[1].focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "50 mi" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "50 mi" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "10 mi" })).toHaveFocus();
  });

  it("does not reopen the list when a slower request answers after a choice", async () => {
    const user = userEvent.setup();
    let release: (places: GeoPoint[]) => void = () => undefined;
    const slow = vi.fn(
      (query: string) =>
        new Promise<GeoPoint[]>((resolve) => {
          release = resolve;
          void query;
        }),
    );
    const onChange = vi.fn();
    render(<PlaceCombobox id="origin" label="Origin" value={null} onChange={onChange} search={slow} />);
    const input = screen.getByRole("combobox", { name: "Origin" });
    await user.type(input, "Ama");
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());
    // Backspacing below three letters must clear the "Searching" state of the aborted request.
    await user.clear(input);
    expect(screen.queryByText("Searching…")).toBeNull();
    release([{ label: "Amarillo, TX, USA", lat: 35.2, lon: -101.8 }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("tells the user when address search is unavailable", async () => {
    const user = userEvent.setup();
    const broken = vi.fn(async (): Promise<GeoPoint[]> => {
      throw new ApiError(503, "not_configured", "Set TOMTOM_API_KEY");
    });
    render(<PlaceCombobox id="origin" label="Origin" value={null} onChange={vi.fn()} search={broken} />);
    await user.type(screen.getByRole("combobox", { name: "Origin" }), "Dal");
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument();
  });

  it("steps through variables with arrow keys and restarts playback from the last frame", async () => {
    const user = userEvent.setup();
    const onFrame = vi.fn();
    render(<HeatmapBar startIso="2026-11-16T14:00:00Z" status="ready" onRetry={vi.fn()} onFrame={onFrame} />);
    screen.getByRole("radio", { name: "Risk" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Wind" })).toHaveFocus();
    expect(onFrame).toHaveBeenLastCalledWith(0, "wind", true);
    fireEvent.change(screen.getByRole("slider", { name: /Forecast hour/ }), { target: { value: "48" } });
    await user.click(screen.getByRole("button", { name: "Play forecast" }));
    expect(onFrame).toHaveBeenLastCalledWith(0, "wind", true);
    expect(screen.getByRole("button", { name: "Pause forecast" })).toBeInTheDocument();
  });
});
