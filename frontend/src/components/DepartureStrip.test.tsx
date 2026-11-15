import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DepartureOptionsResponse } from "../api/types";
import departureFixture from "../mocks/departure-options.mock.json";
import { DepartureStrip } from "./DepartureStrip";

const base = (departureFixture as unknown as Record<string, DepartureOptionsResponse>).c0ffee25;
const data: DepartureOptionsResponse = { ...base, options: base.options.slice(0, 25) };
const labelOf = (id: string) => ({ r1: "Route A", r2: "Route B", r3: "Route C" })[id] ?? id;

function renderStrip(props: Partial<Parameters<typeof DepartureStrip>[0]> = {}) {
  const onApply = vi.fn();
  const onRetry = vi.fn();
  render(
    <DepartureStrip
      status="ready"
      data={data}
      labelOf={labelOf}
      generatedAt="2026-11-15T14:00:00Z"
      onApply={onApply}
      onRetry={onRetry}
      {...props}
    />,
  );
  return { onApply, onRetry };
}

describe("DepartureStrip", () => {
  it("renders one named radio per hour with the planned departure selected", () => {
    renderStrip();
    const bars = screen.getAllByTestId("departure-bar");
    expect(bars).toHaveLength(25);
    expect(bars[0]).toHaveAttribute("aria-checked", "true");
    expect(bars[0]).toHaveAccessibleName(/^Planned departure · .* · Route A · 0 mi Severe or worse · 125 mi High$/);
    expect(bars[8]).toHaveAccessibleName(/^\+8 h · .* · Route A · 0 mi Severe or worse · 0 mi High · suggested$/);
    expect(bars[8]).toHaveAttribute("title", expect.stringMatching(/^\+8 h/));
  });

  it("shows the suggestion and applies it from the keyboard", async () => {
    const user = userEvent.setup();
    const { onApply } = renderStrip();
    const callout = screen.getByTestId("departure-suggestion");
    expect(callout).toHaveTextContent("Leave 8 h later on Route A to cut High-risk miles by 125 mi.");
    await user.tab();
    // Tab order inside the panel: the Apply button comes before the strip.
    expect(within(callout).getByRole("button", { name: /^Apply/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledWith(data.suggestion!.departure);
  });

  it("walks the bars with the arrow keys and offers to plan the picked hour", async () => {
    const user = userEvent.setup();
    const { onApply } = renderStrip();
    expect(screen.queryByTestId("apply-picked")).toBeNull();
    const bars = screen.getAllByTestId("departure-bar");
    bars[0].focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(bars[3]).toHaveFocus();
    expect(bars[3]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("departure-detail")).toHaveTextContent(/^\+3 h/);
    await user.click(screen.getByTestId("apply-picked"));
    expect(onApply).toHaveBeenCalledWith(data.options[3].departure);
  });

  it("says so when no later departure is better", () => {
    renderStrip({ data: { ...data, suggestion: null }, generatedAt: "2026-11-16T21:40:00Z" });
    expect(screen.queryByTestId("departure-suggestion")).toBeNull();
    expect(screen.getByTestId("departure-stay")).toHaveTextContent(
      "Leaving now is already the lowest-risk option in the next 24 h.",
    );
  });

  it("loads quietly and offers a retry on error without blocking anything", async () => {
    const user = userEvent.setup();
    const { onRetry } = renderStrip({ status: "error", data: null, error: "Departure options did not load." });
    expect(screen.getByText(/Departure options did not load/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows a skeleton while loading", () => {
    renderStrip({ status: "loading", data: null });
    expect(screen.getByRole("status")).toHaveTextContent(/Checking the next 24 hours/);
    expect(screen.queryAllByTestId("departure-bar")).toHaveLength(0);
  });
});
