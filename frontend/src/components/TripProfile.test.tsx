import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlanResponse, RouteOption } from "../api/types";
import plansFixture from "../mocks/plans.json";
import { TripProfile } from "./TripProfile";

const plan = (plansFixture as unknown as { plans: Record<"25", PlanResponse> }).plans["25"];
const route = plan.routes.find((item) => item.summary.breaks.length === 2) as RouteOption;

function setup() {
  const handlers = {
    onTruck: vi.fn(),
    onHour: vi.fn(),
    onPlaying: vi.fn(),
    onFocusCheckpoint: vi.fn(),
  };
  const view = render(<TripProfile route={route} heatStartIso={route.departure} {...handlers} />);
  return { ...handlers, ...view };
}

describe("TripProfile", () => {
  it("exposes the chart as a slider over route miles with a text summary", () => {
    setup();
    const chart = screen.getByRole("slider", { name: `Inspect weather along ${route.label}` });
    expect(chart).toHaveAttribute("aria-valuemin", "0");
    expect(chart).toHaveAttribute("aria-valuemax", String(Math.round(route.distance_mi)));
    const described = document.getElementById(chart.getAttribute("aria-describedby")!)!;
    expect(described).toHaveTextContent(/Weather profile for Route A/);
    expect(described).toHaveTextContent(/30-min break near mile/);
  });

  it("moves a cursor with the arrow keys and highlights the nearest checkpoint on the map", async () => {
    const user = userEvent.setup();
    const { onFocusCheckpoint } = setup();
    const chart = screen.getByRole("slider");
    chart.focus();
    await user.keyboard("{ArrowRight}");
    expect(onFocusCheckpoint).toHaveBeenLastCalledWith(route.id, route.checkpoints[0].index);
    expect(chart).toHaveAttribute("aria-valuenow", "0");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(onFocusCheckpoint).toHaveBeenLastCalledWith(route.id, route.checkpoints[2].index);
    expect(chart).toHaveAttribute("aria-valuetext", expect.stringMatching(/^Mile \d+ · .* · Wind .* mph · \w+/));
    expect(screen.getByTestId("trip-readout")).toHaveTextContent(/^Mile \d+ · /);
    await user.keyboard("{End}");
    expect(onFocusCheckpoint).toHaveBeenLastCalledWith(route.id, route.checkpoints.at(-1)!.index);
    await user.keyboard("{Home}");
    expect(onFocusCheckpoint).toHaveBeenLastCalledWith(route.id, route.checkpoints[0].index);
    await user.keyboard("{Escape}");
    expect(onFocusCheckpoint).toHaveBeenLastCalledWith(route.id, null);
    expect(chart).toHaveAttribute("aria-valuetext", "No mile selected");
  });

  it("follows the pointer and lets go when a mouse leaves", () => {
    const { onFocusCheckpoint } = setup();
    const chart = screen.getByTestId("weather-profile");
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, right: 340, bottom: 186, width: 340, height: 186, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(chart, { clientX: 170, clientY: 50, pointerType: "mouse" });
    const middle = onFocusCheckpoint.mock.calls.at(-1)!;
    expect(middle[0]).toBe(route.id);
    expect(middle[1]).toBeGreaterThan(0);
    expect(middle[1]).toBeLessThan(route.checkpoints.length - 1);
    fireEvent.pointerLeave(chart, { pointerType: "mouse" });
    expect(onFocusCheckpoint).toHaveBeenLastCalledWith(route.id, null);
  });

  it("clears the map ring when the route goes away", async () => {
    const user = userEvent.setup();
    const { onFocusCheckpoint, unmount } = setup();
    screen.getByRole("slider").focus();
    await user.keyboard("{ArrowRight}");
    onFocusCheckpoint.mockClear();
    unmount();
    expect(onFocusCheckpoint).toHaveBeenCalledWith(route.id, null);
  });

  it("offers Play trip with a speed choice and no Stop until a trip exists", () => {
    setup();
    expect(screen.getByRole("button", { name: "Play trip" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /1x speed/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("steps through checkpoints instead of animating when motion is reduced", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      const user = userEvent.setup();
      const { onTruck, onHour } = setup();
      expect(screen.queryByRole("button", { name: "Play trip" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Start trip" }));
      expect(onTruck).toHaveBeenLastCalledWith(expect.objectContaining({ mile: 0 }));
      await user.click(screen.getByRole("button", { name: "Next checkpoint" }));
      expect(onTruck.mock.calls.at(-1)![0].mile).toBeCloseTo(route.checkpoints[1].mile, 0);
      expect(onHour).toHaveBeenCalled();
      expect(screen.getByTestId("trip-readout")).toHaveTextContent(/^Mile \d+ · /);
      await user.click(screen.getByRole("button", { name: "Stop" }));
      expect(onTruck).toHaveBeenLastCalledWith(null);
    } finally {
      window.matchMedia = original;
    }
  });
});
