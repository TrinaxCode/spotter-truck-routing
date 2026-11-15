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

describe("HeatmapBar following the trip", () => {
  const props = {
    startIso: "2026-11-16T05:00:00Z",
    departureIso: "2026-11-16T05:00:00Z",
    status: "ready" as const,
    onRetry: noop,
  };

  it("shows the truck's hour, keeps the heatmap on it and locks the slider while it drives", () => {
    const onFrame = vi.fn();
    const { rerender } = render(<HeatmapBar {...props} onFrame={onFrame} followHour={null} locked={false} />);
    expect(screen.getByTestId("heatmap-slider")).toBeEnabled();

    rerender(<HeatmapBar {...props} onFrame={onFrame} followHour={7} locked />);
    const slider = screen.getByTestId("heatmap-slider");
    expect(slider).toHaveValue("7");
    expect(slider).toBeDisabled();
    expect(screen.getByRole("button", { name: "Play forecast" })).toBeDisabled();
    expect(onFrame).toHaveBeenLastCalledWith(7, "risk", true);
    expect(screen.getByTestId("forecast-clock")).toHaveTextContent("+7 h from departure");

    rerender(<HeatmapBar {...props} onFrame={onFrame} followHour={8} locked />);
    expect(onFrame).toHaveBeenLastCalledWith(8, "risk", true);

    // Playback ends: the slider stays on the truck's last hour and is usable again.
    rerender(<HeatmapBar {...props} onFrame={onFrame} followHour={null} locked={false} />);
    expect(slider).toHaveValue("8");
    expect(slider).toBeEnabled();
  });
});
