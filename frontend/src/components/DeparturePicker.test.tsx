import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeparturePicker } from "./DeparturePicker";

const NOW = new Date(2026, 10, 16, 10, 15);

function Harness({ initial = "2026-11-16T11:00", error }: { initial?: string; error?: string }) {
  const [value, setValue] = useState(initial);
  return <DeparturePicker id="departure" value={value} now={NOW} error={error} onChange={setValue} />;
}

describe("DeparturePicker", () => {
  it("opens from the current value and offers quick picks, 15 days, and hours", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByTestId("departure-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("data-departure", "2026-11-16T11:00");
    expect(trigger).toHaveTextContent("Mon, Nov 16 · 11:00 AM");
    expect(screen.getByTestId("departure-summary")).toHaveTextContent(/in 45 min$/);

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Choose a departure" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Now" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "In 2 h" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tonight 8 PM" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tomorrow 6 AM" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: /November \d+/ })).toHaveLength(15);
    expect(screen.getByRole("radio", { name: /^Today,/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "11 AM" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("departure-window")).toHaveTextContent(/before the one-hour window/);
    const days = screen.getAllByRole("radio", { name: /November/ });
    expect(days.filter((day) => day.tabIndex === 0)).toHaveLength(1);
  });

  it("sets tomorrow at 6 AM from a quick pick and keeps that choice highlighted", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("departure-trigger"));
    await user.click(screen.getByRole("radio", { name: "Tomorrow 6 AM" }));
    const trigger = screen.getByTestId("departure-trigger");
    expect(trigger).toHaveAttribute("data-departure", "2026-11-17T06:00");
    expect(screen.getByRole("radio", { name: "Tomorrow 6 AM" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^Tomorrow,/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "6 AM" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: ":00" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("departure-summary")).toHaveTextContent(
      /Leaves Tue, Nov 17 · 6:00 AM .+ · in 19 h 45 min/,
    );
  });

  it("moves the day and the hour with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("departure-trigger"));
    screen.getByRole("radio", { name: /^Today,/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("departure-trigger")).toHaveAttribute("data-departure", "2026-11-17T11:00");
    expect(screen.getByRole("radio", { name: /^Tomorrow,/ })).toHaveFocus();

    screen.getByRole("radio", { name: "11 AM" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("departure-trigger")).toHaveAttribute("data-departure", "2026-11-17T12:00");
    expect(screen.getByRole("radio", { name: "12 PM" })).toHaveFocus();
  });

  it("disables minutes outside the window and keeps an off-quarter suggestion", async () => {
    const user = userEvent.setup();
    const view = render(<DeparturePicker id="departure" value="2026-11-16T11:00" now={NOW} onChange={vi.fn()} />);
    await user.click(screen.getByTestId("departure-trigger"));
    view.rerender(<DeparturePicker id="departure" value="2026-11-16T09:00" now={NOW} onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /^:00/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("radio", { name: ":15" })).not.toHaveAttribute("aria-disabled");

    view.rerender(<DeparturePicker id="departure" value="2026-11-16T11:20" now={NOW} onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: ":20" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("departure-trigger")).toHaveTextContent("Mon, Nov 16 · 11:20 AM");
  });

  it("closes on Escape and on an outside click, and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <Harness />
      </>,
    );
    const trigger = screen.getByTestId("departure-trigger");
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("departure-panel")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("departure-panel")).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByTestId("departure-panel")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("shows the validation message instead of the summary while closed", () => {
    render(<Harness error="Departure must be within the next 14 days." />);
    const trigger = screen.getByTestId("departure-trigger");
    expect(trigger).toHaveAttribute("data-invalid", "true");
    expect(trigger).toHaveAttribute("aria-describedby", "departure-error");
    expect(screen.getByText("Departure must be within the next 14 days.")).toBeInTheDocument();
    expect(screen.queryByTestId("departure-summary")).toBeNull();
  });
});
