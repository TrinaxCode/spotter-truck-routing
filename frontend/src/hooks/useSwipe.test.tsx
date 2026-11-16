import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanResponse, RouteOption } from "../api/types";
import { RouteList } from "../components/RouteList";
import {
  dampOverscroll,
  hourDeltaFromSwipe,
  indexAt,
  lockAxis,
  routeStepFromSwipe,
  slideFeedback,
} from "./useSwipe";

function route(id: string, label: string, rank: number): RouteOption {
  return {
    id,
    label,
    rank,
    recommended: rank === 1,
    geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    distance_mi: 100,
    drive_time_s: 3600,
    total_time_s: 3600,
    departure: "2026-11-16T14:00:00Z",
    arrival: "2026-11-16T15:00:00Z",
    summary: {
      miles_by_level: { low: 100, moderate: 0, high: 0, severe: 0, no_travel: 0, unknown: 0 },
      avg_risk: 0,
      max_level: 0,
      weather_coverage: 1,
      checkpoint_count: 0,
      breaks: [],
    },
    checkpoints: [],
  };
}

const plan: PlanResponse = {
  plan_id: "p",
  generated_at: "2026-11-16T14:00:00Z",
  request: {
    origin: { lat: 0, lon: 0, label: "Dallas" },
    destination: { lat: 1, lon: 1, label: "Denver" },
    departure: "2026-11-16T14:00:00Z",
    load_lbs: 1000,
    interval_mi: 25,
    hos: false,
  },
  recommended_route_id: "a",
  recommendation: { route_id: "a", explanation: [] },
  warnings: [],
  routes: [route("b", "Route B", 3), route("a", "Route A", 1), route("c", "Route C", 2)],
};

function installPhone(on: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("max-width"),
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

function pointer(target: Element, type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) {
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

describe("swipe math", () => {
  it("locks an axis only after the slop, and a 45° tie stays horizontal", () => {
    expect(lockAxis(0, 0)).toBeNull();
    expect(lockAxis(9, 9)).toBeNull();
    expect(lockAxis(10, 0)).toBe("x");
    expect(lockAxis(0, 10)).toBe("y");
    expect(lockAxis(10, 10)).toBe("x");
    expect(lockAxis(10, 14)).toBe("y");
  });

  it("steps a forecast hour once per 24px, with a leftward finger moving time forward", () => {
    expect(hourDeltaFromSwipe(0)).toBe(0);
    expect(hourDeltaFromSwipe(-23)).toBe(0);
    expect(hourDeltaFromSwipe(-24)).toBe(1);
    expect(hourDeltaFromSwipe(-60)).toBe(2);
    expect(hourDeltaFromSwipe(24)).toBe(-1);
    expect(hourDeltaFromSwipe(10, 0)).toBe(0);
  });

  it("maps a horizontal route swipe to the neighbour and ignores a short nudge", () => {
    expect(routeStepFromSwipe(-36)).toBe(1);
    expect(routeStepFromSwipe(-35)).toBe(0);
    expect(routeStepFromSwipe(36)).toBe(-1);
    expect(routeStepFromSwipe(0)).toBe(0);
  });

  it("maps a finger x to a bar, keeping the right edge on the last cell", () => {
    expect(indexAt(0, 0, 250, 25)).toBe(0);
    expect(indexAt(35, 0, 250, 25)).toBe(3);
    expect(indexAt(250, 0, 250, 25)).toBe(24);
    expect(indexAt(999, 0, 250, 25)).toBe(24);
    expect(indexAt(-10, 0, 250, 25)).toBe(0);
    expect(indexAt(10, 0, 0, 25)).toBe(0);
    expect(indexAt(10, 0, 250, 1)).toBe(0);
  });

  it("slides a card 1:1 and then resists", () => {
    expect(slideFeedback(0)).toBe(0);
    expect(slideFeedback(20)).toBe(20);
    expect(slideFeedback(-20)).toBe(-20);
    const stretched = slideFeedback(80);
    expect(stretched).toBeGreaterThan(40);
    expect(stretched).toBeLessThan(80);
    expect(stretched).toBeCloseTo(40 + dampOverscroll(40, 36));
  });
});

describe("RouteList swipe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderList(selectedId = "a") {
    const onSelect = vi.fn();
    render(
      <RouteList plan={plan} selectedId={selectedId} onSelect={onSelect} onInspect={() => undefined} />,
    );
    return onSelect;
  }

  it("selects the next route on a left swipe and does not wrap", () => {
    const restore = installPhone(true);
    try {
      const onSelect = renderList("a");
      const button = screen.getByRole("button", { name: /Route A/ });
      const card = button.closest("[data-testid='route-card']") as HTMLElement;
      pointer(button, "pointerDown", 180, 40);
      pointer(button, "pointerMove", 140, 42);
      expect(card.dataset.dragging).toBe("true");
      expect(card.style.transform).toContain("translateX");
      pointer(button, "pointerUp", 130, 42);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith("c");
      expect(card.dataset.dragging).toBe("settle");
    } finally {
      restore();
    }
  });

  it("does not wrap past the last route", () => {
    const restore = installPhone(true);
    try {
      const onSelect = renderList("b");
      const last = screen.getByRole("button", { name: /Route B/ });
      pointer(last, "pointerDown", 180, 40);
      pointer(last, "pointerMove", 120, 40);
      pointer(last, "pointerUp", 120, 40);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("uses the last move when pointerup repeats the start point", () => {
    const restore = installPhone(true);
    try {
      const onSelect = renderList("c");
      const button = screen.getByRole("button", { name: /Route C/ });
      pointer(button, "pointerDown", 80, 40);
      pointer(button, "pointerMove", 140, 42);
      pointer(button, "pointerUp", 80, 40);
      expect(onSelect).toHaveBeenCalledWith("a");
    } finally {
      restore();
    }
  });

  it("selects the previous route on a right swipe and ignores a vertical move", () => {
    const restore = installPhone(true);
    try {
      const onSelect = renderList("c");
      const button = screen.getByRole("button", { name: /Route C/ });
      pointer(button, "pointerDown", 80, 40);
      pointer(button, "pointerMove", 130, 44);
      pointer(button, "pointerUp", 130, 44);
      expect(onSelect).toHaveBeenCalledWith("a");

      onSelect.mockClear();
      pointer(button, "pointerDown", 80, 40);
      pointer(button, "pointerMove", 84, 90);
      pointer(button, "pointerUp", 84, 90);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("does not steal the selection on a desktop pointer drag", () => {
    const restore = installPhone(false);
    try {
      const onSelect = renderList("a");
      const button = screen.getByRole("button", { name: /Route A/ });
      pointer(button, "pointerDown", 180, 40);
      pointer(button, "pointerMove", 100, 40);
      pointer(button, "pointerUp", 100, 40);
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.click(button);
      expect(onSelect).toHaveBeenCalledWith("a");
    } finally {
      restore();
    }
  });
});
