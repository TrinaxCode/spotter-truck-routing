import { describe, expect, it, vi } from "vitest";
import { distanceToLine, hapticHint, nearestPointIndex, withinPressSlop } from "./gestures";

describe("touch geometry", () => {
  it("allows exactly 8 px of movement in any direction, not 8 px on each axis", () => {
    expect(withinPressSlop({ x: 10, y: 20 }, { x: 18, y: 20 })).toBe(true);
    expect(withinPressSlop({ x: 10, y: 20 }, { x: 18.01, y: 20 })).toBe(false);
    expect(withinPressSlop({ x: 0, y: 0 }, { x: 6, y: 6 })).toBe(false);
  });

  it("measures to the actual line, clamps at endpoints and handles repeated coordinates", () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }];
    expect(distanceToLine({ x: 5, y: 20 }, line)).toBe(20);
    expect(distanceToLine({ x: 13, y: 4 }, line)).toBe(5);
    expect(distanceToLine({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5);
    expect(distanceToLine({ x: 0, y: 0 }, [])).toBe(Infinity);
  });

  it("chooses the nearest checkpoint in screen space, including empty and tied cases", () => {
    expect(nearestPointIndex({ x: 9, y: 2 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(1);
    expect(nearestPointIndex({ x: 5, y: 0 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(0);
    expect(nearestPointIndex({ x: 0, y: 0 }, [])).toBe(-1);
  });
});

describe("haptic hint", () => {
  it("vibrates briefly only when supported and motion is allowed", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    hapticHint();
    expect(vibrate).toHaveBeenCalledWith(8);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    hapticHint();
    expect(vibrate).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", {});
    expect(() => hapticHint()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
