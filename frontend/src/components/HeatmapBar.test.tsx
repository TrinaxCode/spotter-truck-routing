import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeatmapBar } from "./HeatmapBar";

const noop = () => undefined;

describe("HeatmapBar frame labels", () => {
  it("labels frame 0 relative to the real departure, not the floored hour", () => {
    render(
      <HeatmapBar
        startIso="2026-11-16T05:00:00Z"
        departureIso="2026-11-16T05:20:00Z"
        status="ready"
        onRetry={noop}
        onFrame={noop}
      />,
    );
    expect(screen.getByTestId("forecast-clock")).toHaveTextContent("20 min before departure");
    expect(screen.getByTestId("forecast-clock")).not.toHaveTextContent("At departure");
    expect(screen.getByTestId("heatmap-slider")).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("20 min before departure"),
    );
  });

  it("says At departure when the departure is on the hour", () => {
    render(
      <HeatmapBar
        startIso="2026-11-16T05:00:00Z"
        departureIso="2026-11-16T05:00:00Z"
        status="ready"
        onRetry={noop}
        onFrame={noop}
      />,
    );
    expect(screen.getByTestId("forecast-clock")).toHaveTextContent("At departure");
  });

  it("explains an empty variable and retries, without a slider to drag", () => {
    const onRetry = vi.fn();
    render(
      <HeatmapBar
        startIso="2026-11-16T05:00:00Z"
        departureIso="2026-11-16T05:00:00Z"
        coverage={{ risk: "none", wind: "full", rain: "partial", snow: "none" }}
        status="ready"
        onRetry={onRetry}
        onFrame={noop}
      />,
    );
    expect(screen.getByTestId("forecast-clock")).toHaveTextContent(/No Risk values came back/);
    expect(screen.getByTestId("heatmap-slider")).toBeDisabled();
    screen.getByRole("button", { name: "Retry forecast" }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
