import { describe, expect, it } from "vitest";
import { assess, rainLevel, snowLevel, windLevel, windLevelWithLoad } from "./assess";
import { elapsedWithBreaks } from "./hos";

describe("fixture domain rules", () => {
  it("pins wind, rain, snow, and load edges", () => {
    expect(windLevel(24.9)).toBe(0);
    expect(windLevel(25)).toBe(1);
    expect(windLevel(34.9)).toBe(1);
    expect(windLevel(35)).toBe(2);
    expect(windLevel(45)).toBe(3);
    expect(windLevel(54.9)).toBe(3);
    expect(windLevel(55)).toBe(4);
    expect(rainLevel(0.1)).toBe(1);
    expect(rainLevel(1)).toBe(3);
    expect(rainLevel(1.01)).toBe(4);
    expect(snowLevel(3)).toBe(3);
    expect(snowLevel(3.01)).toBe(4);
    expect(windLevelWithLoad(47, 30000)).toBe(3);
    expect(windLevelWithLoad(47, 30001)).toBe(4);
    expect(windLevelWithLoad(35, 40000)).toBe(2);
    expect(windLevelWithLoad(35, 40001)).toBe(3);
    expect(windLevelWithLoad(55, 0)).toBe(4);
  });

  it("keeps gusts out of the level and explains escalations", () => {
    const result = assess(47, 0, 0, 35000);
    expect(result.level).toBe(4);
    expect(result.reasons[0]).toContain("35,000 lb");
    expect(result.reasons[0]).toContain("No Travel");
    expect(assess(10, 0, 0, 35000).reasons).toEqual([]);
  });

  it("does not add a trailing break when driving stops on a limit", () => {
    expect(elapsedWithBreaks(8 * 3600)).toBe(8 * 3600);
    expect(elapsedWithBreaks(8 * 3600 + 1)).toBe(8 * 3600 + 30 * 60 + 1);
    expect(elapsedWithBreaks(11 * 3600)).toBe(11.5 * 3600);
    expect(elapsedWithBreaks(11 * 3600 + 1)).toBe(11.5 * 3600 + 10 * 3600 + 1);
    expect(elapsedWithBreaks(11 * 3600, false)).toBe(11 * 3600);
  });
});
