import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlanResponse } from "../api/types";
import planSample from "../mocks/backend-plan.sample.json";
import { DriverBriefing } from "./DriverBriefing";

const plan = planSample as unknown as PlanResponse;

describe("DriverBriefing", () => {
  it("prints every route ranked and one log row per checkpoint of the selected route", () => {
    const route = plan.routes[1];
    render(<DriverBriefing plan={plan} route={route} origin="Dallas" destination="Denver" />);
    const sheet = document.body.querySelector(".briefing")!;
    expect(sheet).toHaveTextContent("Dallas → Denver");
    const rankRows = sheet.querySelectorAll("table:not(.briefing-log) tbody tr");
    expect([...rankRows].map((row) => row.firstElementChild?.textContent)).toEqual(
      [...plan.routes].sort((a, b) => a.rank - b.rank).map((item) => String(item.rank)),
    );
    expect(sheet.querySelector(`tr[data-selected="true"]`)).toHaveTextContent(route.label);
    expect(sheet.querySelectorAll(".briefing-log tbody tr")).toHaveLength(route.checkpoints.length);
    for (const warning of plan.warnings) expect(sheet).toHaveTextContent(warning);
  });

  it("marks checkpoints without a forecast as unknown instead of inventing values", () => {
    const route = plan.routes.find((item) => item.checkpoints.some((checkpoint) => checkpoint.weather === null))!;
    render(<DriverBriefing plan={plan} route={route} origin="A" destination="B" />);
    const rows = [...document.body.querySelectorAll(".briefing-log tbody tr")];
    const missing = rows[route.checkpoints.findIndex((checkpoint) => checkpoint.weather === null)];
    expect(missing).toHaveTextContent("Unknown");
    expect(missing).toHaveTextContent("—");
  });
});
