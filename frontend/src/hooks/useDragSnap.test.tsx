import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TripSheet } from "../components/TripSheet";
import {
  FLICK_PX_PER_MS,
  nearestSnap,
  rubberBand,
  settleSnap,
  snapTravel,
  velocityFromSamples,
  type SnapPoints,
} from "./useDragSnap";

const points: SnapPoints = { expanded: 0, half: 200, collapsed: 452 };

function installMedia(matches: (query: string) => boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function installSheetBoxes() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    let height = 0;
    if (this.classList.contains("sheet-handle")) height = 48;
    else if (this.id === "trip-panel") {
      if (this.style.height === "62dvh") height = 500;
      else if (this.style.height === "36dvh") height = 300;
      else if (this.style.height.endsWith("px")) height = Number.parseFloat(this.style.height);
      else height = 500;
    }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: height,
      width: 100,
      height,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

function pointer(
  target: Element,
  type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel",
  x: number,
  y: number,
) {
  fireEvent[type](target, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    isPrimary: true,
    bubbles: true,
  });
}

describe("sheet snap math", () => {
  it("rejects heights that are not expanded > half > collapsed", () => {
    expect(snapTravel(500, 300, 48)).toEqual({ expanded: 0, half: 200, collapsed: 452 });
    expect(snapTravel(300, 300, 48)).toBeNull();
    expect(snapTravel(500, 48, 300)).toBeNull();
    expect(snapTravel(500, 300, 0)).toBeNull();
  });

  it("rubber-bands past the ends and stays identity inside them", () => {
    expect(rubberBand(40, 0, 100)).toBe(40);
    expect(rubberBand(0, 0, 100)).toBe(0);
    expect(rubberBand(100, 0, 100)).toBe(100);
    const above = rubberBand(-40, 0, 100);
    const further = rubberBand(-80, 0, 100);
    expect(above).toBeLessThan(0);
    expect(above).toBeGreaterThan(-120);
    expect(further).toBeLessThan(above);
    expect(further).toBeGreaterThan(-120);
    const below = rubberBand(160, 0, 100);
    expect(below).toBeGreaterThan(100);
    expect(below).toBeLessThan(220);
    expect(rubberBand(180, 0, 100)).toBeGreaterThan(below);
  });

  it("breaks an exact tie toward the bias, and keeps the more-expanded snap without one", () => {
    const tied: SnapPoints = { expanded: 0, half: 100, collapsed: 200 };
    expect(nearestSnap(tied, 50, 0)).toBe("expanded");
    expect(nearestSnap(tied, 50, 1)).toBe("half");
    expect(nearestSnap(tied, 50, -1)).toBe("expanded");
    expect(nearestSnap(points, 120, 0)).toBe("half");
  });

  it("settles on position when the finger is slow and steps one snap on a flick", () => {
    expect(settleSnap(points, 120, 0)).toBe("half");
    expect(settleSnap(points, 120, FLICK_PX_PER_MS - 0.01)).toBe("half");
    // 40px is still in the expanded basin. A downward flick steps to half, not collapsed.
    expect(settleSnap(points, 40, 2)).toBe("half");
    // Already in the collapsed basin: a further flick stays on the end.
    expect(settleSnap(points, 400, 0.1)).toBe("collapsed");
    expect(settleSnap(points, 400, 3)).toBe("collapsed");
    // A flick up from the half basin opens one snap.
    expect(settleSnap(points, 180, -2)).toBe("expanded");
    expect(settleSnap(points, 10, -2)).toBe("expanded");
  });

  it("reads velocity from the recent window and keeps a slow two-sample drag slow", () => {
    expect(velocityFromSamples([{ y: 0, t: 0 }])).toBe(0);
    expect(velocityFromSamples([{ y: 0, t: 0 }, { y: 10, t: 1000 }])).toBeCloseTo(0.01);
    expect(
      velocityFromSamples([
        { y: 0, t: 0 },
        { y: 30, t: 1000 },
        { y: 90, t: 1050 },
      ]),
    ).toBeCloseTo(1.2);
    expect(
      velocityFromSamples([
        { y: 0, t: 0 },
        { y: 100, t: 50 },
        { y: 100, t: 400 },
      ]),
    ).toBe(0);
  });
});

describe("TripSheet drag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts expanded on a phone and cycles snaps from a click or the keyboard", async () => {
    const restore = installMedia((query) => query.includes("max-width") || query.includes("prefers-reduced-motion"));
    try {
      const user = userEvent.setup();
      render(
        <TripSheet title="Dallas → Denver">
          <p>Body</p>
        </TripSheet>,
      );
      const handle = screen.getByRole("button", { name: /trip panel/ });
      const sheet = document.getElementById("trip-panel");
      expect(sheet).toHaveAttribute("data-snap", "expanded");
      await user.click(handle);
      expect(sheet).toHaveAttribute("data-snap", "collapsed");
      handle.focus();
      await user.keyboard("{Enter}");
      expect(sheet).toHaveAttribute("data-snap", "half");
      await user.keyboard(" ");
      expect(sheet).toHaveAttribute("data-snap", "expanded");
    } finally {
      restore();
    }
  });

  it("follows the finger and snaps by position, including a one-snap flick", () => {
    const restoreMedia = installMedia(
      (query) => query.includes("max-width") || query.includes("prefers-reduced-motion"),
    );
    const restoreBox = installSheetBoxes();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      render(
        <TripSheet title="Dallas → Denver">
          <p>Body</p>
        </TripSheet>,
      );
      const handle = screen.getByRole("button", { name: /trip panel/ });
      const sheet = document.getElementById("trip-panel")!;

      now = 1_000;
      pointer(handle, "pointerDown", 40, 100);
      now = 1_020;
      pointer(handle, "pointerMove", 40, 130);
      expect(sheet.dataset.dragging).toBe("true");
      expect(sheet.style.height).toBe("500px");
      expect(sheet.style.willChange).toBe("transform");
      expect(sheet.style.transform).toBe("translateY(30px)");
      now = 1_600;
      pointer(handle, "pointerMove", 40, 220);
      pointer(handle, "pointerUp", 40, 220);
      expect(sheet).toHaveAttribute("data-snap", "half");
      expect(sheet.style.transform).toBe("");
      expect(sheet.dataset.dragging).toBeUndefined();

      // The click a drag synthesizes does not cycle. The next tap does, back to expanded.
      fireEvent.click(handle);
      expect(sheet).toHaveAttribute("data-snap", "half");
      fireEvent.click(handle);
      expect(sheet).toHaveAttribute("data-snap", "expanded");
      now = 2_000;
      pointer(handle, "pointerDown", 40, 100);
      now = 2_030;
      pointer(handle, "pointerMove", 40, 155);
      pointer(handle, "pointerUp", 40, 155);
      expect(sheet).toHaveAttribute("data-snap", "half");
    } finally {
      restoreBox();
      restoreMedia();
    }
  });

  it("does not treat a short press as a drag, so the click still cycles", () => {
    const restoreMedia = installMedia((query) => query.includes("max-width"));
    try {
      render(
        <TripSheet title="Dallas → Denver">
          <p>Body</p>
        </TripSheet>,
      );
      const handle = screen.getByRole("button", { name: /trip panel/ });
      const sheet = document.getElementById("trip-panel")!;
      pointer(handle, "pointerDown", 10, 80);
      pointer(handle, "pointerMove", 12, 86);
      pointer(handle, "pointerUp", 12, 86);
      expect(sheet).toHaveAttribute("data-snap", "expanded");
      expect(sheet.dataset.dragging).toBeUndefined();
      fireEvent.click(handle);
      expect(sheet).toHaveAttribute("data-snap", "collapsed");
    } finally {
      restoreMedia();
    }
  });

  it("drags from the body only when it is scrolled to the top", () => {
    const restoreMedia = installMedia(
      (query) => query.includes("max-width") || query.includes("prefers-reduced-motion"),
    );
    const restoreBox = installSheetBoxes();
    let now = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      render(
        <TripSheet title="Dallas → Denver">
          <p>Body</p>
        </TripSheet>,
      );
      const sheet = document.getElementById("trip-panel")!;
      const body = document.getElementById("trip-panel-body")!;
      Object.defineProperty(body, "scrollTop", { configurable: true, writable: true, value: 40 });
      now = 5_000;
      pointer(body, "pointerDown", 30, 200);
      now = 5_400;
      pointer(body, "pointerMove", 30, 340);
      pointer(body, "pointerUp", 30, 340);
      expect(sheet).toHaveAttribute("data-snap", "expanded");

      body.scrollTop = 0;
      now = 6_000;
      pointer(body, "pointerDown", 30, 200);
      now = 6_500;
      pointer(body, "pointerMove", 30, 320);
      pointer(body, "pointerUp", 30, 320);
      expect(sheet).toHaveAttribute("data-snap", "half");
    } finally {
      restoreBox();
      restoreMedia();
    }
  });

  it("puts the sheet back when the pointer is cancelled", () => {
    const restoreMedia = installMedia(
      (query) => query.includes("max-width") || query.includes("prefers-reduced-motion"),
    );
    const restoreBox = installSheetBoxes();
    vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      render(
        <TripSheet title="Dallas → Denver">
          <p>Body</p>
        </TripSheet>,
      );
      const handle = screen.getByRole("button", { name: /trip panel/ });
      const sheet = document.getElementById("trip-panel")!;
      pointer(handle, "pointerDown", 20, 100);
      pointer(handle, "pointerMove", 20, 240);
      pointer(handle, "pointerCancel", 20, 240);
      expect(sheet).toHaveAttribute("data-snap", "expanded");
      fireEvent.click(handle);
      expect(sheet).toHaveAttribute("data-snap", "collapsed");
    } finally {
      restoreBox();
      restoreMedia();
    }
  });

  it("ignores a drag when the viewport is not a phone", () => {
    const restoreDesktop = installMedia(() => false);
    try {
      render(
        <TripSheet title="Dallas → Denver">
          <p>Body</p>
        </TripSheet>,
      );
      const handle = screen.getByRole("button", { name: /trip panel/ });
      const sheet = document.getElementById("trip-panel")!;
      expect(sheet).toHaveAttribute("data-snap", "half");
      pointer(handle, "pointerDown", 20, 100);
      pointer(handle, "pointerMove", 20, 260);
      pointer(handle, "pointerUp", 20, 260);
      expect(sheet).toHaveAttribute("data-snap", "half");
      fireEvent.click(handle);
      expect(sheet).toHaveAttribute("data-snap", "expanded");
    } finally {
      restoreDesktop();
    }
  });
});
