import { describe, expect, it } from "vitest";
import {
  forecastTicks,
  formatAvgRisk,
  formatDuration,
  formatFrameLabel,
  formatHosBreaks,
  formatLoadLbs,
  formatMiles,
  formatTripSummary,
  parseLoadLbs,
} from "./format";
import { RISK_COLORS, UNKNOWN_COLOR, riskColor, riskLabel } from "./riskColor";
import { departureError, nextFullHourInput } from "./time";

describe("format", () => {
  it("formats US miles, duration, and load", () => {
    expect(formatMiles(839.3)).toBe("839.3 mi");
    expect(formatDuration(5400)).toBe("1 hr 30 min");
    expect(formatDuration(3600)).toBe("1 hr 00 min");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatLoadLbs(35000)).toBe("35,000 lb");
    expect(formatAvgRisk(0.4)).toBe("0.40");
  });

  it("parses whole pounds and rejects decimals", () => {
    expect(parseLoadLbs("35,000")).toBe(35000);
    expect(parseLoadLbs("0")).toBe(0);
    expect(parseLoadLbs("12.5")).toBeNull();
    expect(parseLoadLbs("-1")).toBeNull();
    expect(parseLoadLbs("")).toBeNull();
  });

  it("counts HOS breaks", () => {
    expect(formatHosBreaks(0)).toBe("0 HOS breaks");
    expect(formatHosBreaks(1)).toBe("1 HOS break");
    expect(formatHosBreaks(2)).toBe("2 HOS breaks");
  });

  it("formats the collapsed trip line and the forecast frame", () => {
    expect(
      formatTripSummary({
        origin: "Dallas, TX, USA",
        destination: "Denver, CO, USA",
        departureLocal: "2026-11-16T08:00",
        loadLbs: 35000,
        intervalMi: 25,
      }),
    ).toBe("Dallas → Denver · Nov 16 8:00 AM · 35,000 lb · 25 mi");
    expect(formatFrameLabel("2026-11-16T18:00:00Z", 5)).toMatch(/^\w{3} .+ \(\+5 h\)$/);
    const ticks = forecastTicks("2026-11-16T06:00:00Z");
    expect(ticks.map((tick) => tick.hour)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
    expect(ticks[0]?.day).toBeTruthy();
    expect(ticks.filter((tick) => tick.day).length).toBeGreaterThanOrEqual(2);
  });
});

describe("risk palette", () => {
  it("maps levels to the shared palette", () => {
    expect(riskColor(0)).toBe(RISK_COLORS[0]);
    expect(riskColor(4)).toBe("#c026d3");
    expect(riskColor(null)).toBe(UNKNOWN_COLOR);
    expect(riskLabel(3)).toBe("Severe");
    expect(riskLabel(null)).toBe("Unknown");
  });
});

describe("departure window", () => {
  it("defaults to the next full hour and rejects the edges", () => {
    const now = new Date(2026, 10, 15, 13, 20, 0);
    expect(nextFullHourInput(now)).toBe("2026-11-15T14:00");
    expect(departureError("2026-11-15T12:00", now)).toMatch(/one hour/);
    expect(departureError("2026-11-15T12:30", now)).toBeUndefined();
    expect(departureError("2026-12-30T13:20", now)).toMatch(/14 days/);
  });
});
