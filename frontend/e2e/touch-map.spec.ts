import { expect, test, type CDPSession, type Page } from "@playwright/test";
import type { MapGestureProbe } from "../src/map/handle";

type Point = { x: number; y: number };
type TouchProbe = NonNullable<Window["__spotter"]> & { mapGestures: MapGestureProbe };
const camera = (page: Page) => page.evaluate(() => (window.__spotter as TouchProbe).mapGestures.camera());
const counters = (page: Page) => page.evaluate(() => ({ ...window.__spotter }));

async function planTrip(page: Page) {
  // All tests are independent of external tiles, fonts, sprites and routing/weather APIs.
  await page.route("https://tiles.openfreemap.org/**", (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#17212d" } }] },
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => {
      const root = window as unknown as { haptics: number[] };
      (root.haptics ??= []).push(ms);
      return true;
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByTestId("route-card")).toHaveCount(3);
  await expect(page.getByTestId("heatmap-slider")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__spotter?.sourceUpdates ?? 0)).toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(650); // Initial fitBounds animation, not a gesture timeout.
}

async function touch(session: CDPSession, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: Point[]) {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p, id) => ({ ...p, id, radiusX: 3, radiusY: 3, force: 1 })),
  });
}

async function drag(session: CDPSession, from: Point[], to: Point[]) {
  await touch(session, "touchStart", from);
  for (let i = 1; i <= 8; i++) {
    await touch(session, "touchMove", from.map((p, j) => ({ x: p.x + (to[j].x - p.x) * i / 8, y: p.y + (to[j].y - p.y) * i / 8 })));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await touch(session, "touchEnd", []);
}

/** A real checkpoint (or route segment) in the exposed map, clear of every overlay and pin. */
async function mapPoint(page: Page, kind: "checkpoint" | "line" = "checkpoint", offset = 0, selected = true) {
  return page.evaluate(({ kind, offset, selected }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".map-canvas canvas")!;
    const box = canvas.getBoundingClientRect();
    const allRoutes = (window.__spotter as TouchProbe).mapGestures.routes();
    const routes = allRoutes.filter((r) => r.selected === selected);
    for (const route of routes) {
      const points = kind === "checkpoint" ? route.checkpoints.slice(1, -1) : route.points;
      for (const p of points) {
        const x = box.left + p.x + offset;
        const y = box.top + p.y;
        if (x < 50 || x > innerWidth - 60 || y < 90 || y > innerHeight - 100) continue;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        if (kind === "line" && allRoutes.filter((r) => r.selected).some((r) => r.checkpoints.some((c) => Math.abs(box.left + c.x - x) < 28 && Math.abs(box.top + c.y - y) < 28))) continue;
        return { x, y, routeId: route.id, index: "index" in p ? p.index : -1 };
      }
    }
    throw new Error(`No exposed ${kind} with offset ${offset}`);
  }, { kind, offset, selected });
}

async function freeMapPoint(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".map-canvas canvas")!;
    const box = canvas.getBoundingClientRect();
    const checkpoints = (window.__spotter as TouchProbe).mapGestures.routes().find((r) => r.selected)!.checkpoints;
    for (let y = 180; y < innerHeight - 100; y += 35) {
      for (let x = 90; x < innerWidth - 90; x += 35) {
        if ([[-65, -65], [65, -65], [-65, 65], [65, 65], [0, 0]].some(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) !== canvas)) continue;
        if (checkpoints.some((c) => Math.hypot(box.x + c.x - x, box.y + c.y - y) < 35)) continue;
        return { x, y };
      }
    }
    throw new Error("No free map surface for pinch and double tap");
  });
}

async function openChart(page: Page) {
  const sheet = page.locator("#trip-panel");
  if (await sheet.getAttribute("data-snap") === "half" && await page.getByRole("button", { name: /trip panel/ }).isVisible()) {
    await page.getByRole("button", { name: /trip panel/ }).click();
  }
  const chart = page.getByTestId("weather-profile");
  await chart.scrollIntoViewIfNeeded();
  await expect(chart).toBeVisible();
  return chart;
}

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) {
  test.describe(`touch map and chart ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test("long press inspects the selected route once, rings the finger and gives an optional haptic", async ({ page, context }) => {
      await planTrip(page);
      const at = await mapPoint(page);
      const before = await counters(page);
      const session = await context.newCDPSession(page);
      await touch(session, "touchStart", [at]);
      await expect(page.locator(".map-press-ring")).toBeVisible();
      await expect(page.getByTestId("checkpoint-dialog")).toBeVisible();
      await expect(page.getByTestId("checkpoint-dialog")).toContainText("Route A");
      expect(await page.evaluate(() => (window as unknown as { haptics: number[] }).haptics)).toEqual([8]);
      await touch(session, "touchEnd", []);
      await expect(page.locator(".map-press-ring")).toBeHidden();
      await expect(page.getByTestId("checkpoint-dialog").getByRole("button", { name: "Close" })).toBeFocused();
      expect((await counters(page)).sourceUpdates).toBe(before.sourceUpdates);
      await page.screenshot({ path: `test-results/touch-map-${viewport.width}.png` });
      const close = (await page.getByTestId("checkpoint-dialog").getByRole("button", { name: "Close" }).boundingBox())!;
      await page.touchscreen.tap(close.x + close.width / 2, close.y + close.height / 2);
      await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);
    });

    test("movement, a second finger and pointer cancellation each cancel long press", async ({ page, context }) => {
      await planTrip(page);
      const session = await context.newCDPSession(page);
      const at = await mapPoint(page);
      await touch(session, "touchStart", [at]);
      await touch(session, "touchMove", [{ x: at.x + 9, y: at.y }]);
      await expect(page.locator(".map-press-ring")).toBeHidden();
      await page.waitForTimeout(560);
      await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);
      await touch(session, "touchEnd", []);

      const next = await mapPoint(page);
      await touch(session, "touchStart", [next]);
      await touch(session, "touchStart", [next, { x: next.x + 35, y: next.y }]);
      await expect(page.locator(".map-press-ring")).toBeHidden();
      await page.waitForTimeout(560);
      await touch(session, "touchEnd", []);
      await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);

      await touch(session, "touchStart", [next]);
      await touch(session, "touchCancel", []);
      await page.waitForTimeout(560);
      await expect(page.locator(".map-press-ring")).toBeHidden();
      await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);

      // A second contact over an overlay also cancels the canvas press.
      const overlay = (await page.getByRole("button", { name: "Zoom in", exact: true }).boundingBox())!;
      await touch(session, "touchStart", [next]);
      await touch(session, "touchStart", [next, { x: overlay.x + overlay.width / 2, y: overlay.y + overlay.height / 2 }]);
      await page.waitForTimeout(560);
      await expect(page.locator(".map-press-ring")).toBeHidden();
      await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);
      await touch(session, "touchCancel", []);
    });

    test("finger taps use padded checkpoint and route hit areas", async ({ page }) => {
      await planTrip(page);
      const at = await mapPoint(page, "checkpoint", 21);
      await page.touchscreen.tap(at.x, at.y);
      await expect(page.getByTestId("checkpoint-dialog")).toBeVisible();
      await page.getByTestId("checkpoint-dialog").getByRole("button", { name: "Close" }).click();
      const other = await mapPoint(page, "line", 18, false);
      await page.touchscreen.tap(other.x, other.y);
      await expect.poll(() => page.evaluate((id) => (window.__spotter as TouchProbe).mapGestures.routes().find((r) => r.id === id)?.selected, other.routeId)).toBe(true);
    });

    test("holding an unselected route does not inspect it; pen long press uses the same inspection path", async ({ page, context }) => {
      await planTrip(page);
      const session = await context.newCDPSession(page);
      const other = await mapPoint(page, "line", 18, false);
      await touch(session, "touchStart", [other]);
      await page.waitForTimeout(560);
      await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);
      await touch(session, "touchCancel", []);
      const at = await mapPoint(page);
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1, pointerType: "pen" });
      await expect(page.locator(".map-press-ring")).toBeVisible();
      await expect(page.getByTestId("checkpoint-dialog")).toBeVisible();
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1, pointerType: "pen" });
    });

    test("native pinch, pan and double tap work in the exposed map around the overlays", async ({ page, context }) => {
      await planTrip(page);
      const at = await freeMapPoint(page);
      const session = await context.newCDPSession(page);
      const before = await camera(page);
      await drag(session, [{ x: at.x - 25, y: at.y }, { x: at.x + 25, y: at.y }], [{ x: at.x - 50, y: at.y }, { x: at.x + 50, y: at.y }]);
      await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before.zoom + 0.3);
      const zoomed = await camera(page);
      await page.touchscreen.tap(at.x, at.y);
      await page.touchscreen.tap(at.x, at.y);
      await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(zoomed.zoom + 0.5);
      const routeBefore = await page.evaluate(() => (window.__spotter as TouchProbe).mapGestures.routes()[0].points[0]);
      await drag(session, [at], [{ x: at.x + 45, y: at.y + 20 }]);
      await expect.poll(() => page.evaluate((old) => {
        const p = (window.__spotter as TouchProbe).mapGestures.routes()[0].points[0];
        return Math.hypot(p.x - old.x, p.y - old.y);
      }, routeBefore)).toBeGreaterThan(15);
      expect((await camera(page)).pitch).toBe(0);
      expect((await camera(page)).bearing).toBe(0);
    });

    test("two-finger rotation and pitch stay in Follow; one-finger pan hands back a flat map", async ({ page, context }) => {
      await planTrip(page);
      await page.getByTestId("drive-start").click();
      const hud = page.getByTestId("drive-hud");
      await expect(hud).toBeVisible();
      await hud.getByRole("button", { name: "Pause trip" }).click();
      await expect.poll(async () => (await camera(page)).pitch).toBe(60);
      const session = await context.newCDPSession(page);
      const at = viewport.width === 375 ? { x: 185, y: 300 } : { x: 540, y: 420 };
      const before = await camera(page);
      await drag(session, [{ x: at.x - 45, y: at.y }, { x: at.x + 45, y: at.y }], [{ x: at.x - 30, y: at.y - 30 }, { x: at.x + 30, y: at.y + 30 }]);
      await expect.poll(async () => Math.abs((await camera(page)).bearing - before.bearing)).toBeGreaterThan(10);
      expect((await counters(page)).chase).toBe(true);
      const rotated = await camera(page);
      await drag(session, [{ x: at.x - 35, y: at.y }, { x: at.x + 35, y: at.y }], [{ x: at.x - 35, y: at.y + 55 }, { x: at.x + 35, y: at.y + 55 }]);
      await expect.poll(async () => Math.abs((await camera(page)).pitch - rotated.pitch)).toBeGreaterThan(5);
      expect((await counters(page)).chase).toBe(true);
      const tilted = await camera(page);
      const beforePlayback = await counters(page);
      await hud.getByRole("button", { name: "Resume trip" }).click();
      await expect.poll(async () => (await counters(page)).truckUpdates ?? 0).toBeGreaterThan((beforePlayback.truckUpdates ?? 0) + 3);
      await hud.getByRole("button", { name: "Pause trip" }).click();
      // Native touch inertia may settle by a fraction of a degree after pointerup.
      expect(Math.abs((await camera(page)).pitch - tilted.pitch)).toBeLessThan(2);
      expect((await counters(page)).chase).toBe(true);
      expect((await counters(page)).sourceUpdates).toBe(beforePlayback.sourceUpdates);
      await hud.getByRole("button", { name: "Overview" }).click();
      await expect.poll(async () => (await camera(page)).pitch).toBe(0);
      expect((await camera(page)).bearing).toBe(0);
      expect((await camera(page)).pitching).toBe(false);
      await hud.getByRole("button", { name: "Follow" }).click();
      await expect.poll(async () => (await camera(page)).pitch).toBe(60);
      const canvas = page.locator(".map-canvas canvas").first();
      await canvas.focus();
      const keyboardBefore = await camera(page);
      await canvas.press("Shift+ArrowRight");
      await expect.poll(async () => Math.abs((await camera(page)).bearing - keyboardBefore.bearing)).toBeGreaterThan(10);
      await canvas.press("Shift+ArrowDown");
      await expect.poll(async () => (await camera(page)).pitch).toBeLessThan(55);
      expect((await counters(page)).chase).toBe(true);
      await drag(session, [at], [{ x: at.x + 40, y: at.y + 20 }]);
      await expect.poll(async () => (await counters(page)).chase).toBe(false);
      await expect.poll(async () => (await camera(page)).pitch).toBe(0);
      expect((await camera(page)).pitching).toBe(false);
    });

    test("chart captures a horizontal scrub, keeps the cursor on release, and preserves keyboard and vertical scrolling", async ({ page, context }) => {
      await planTrip(page);
      const chart = await openChart(page);
      expect(await chart.evaluate((node) => getComputedStyle(node).touchAction)).toBe("pan-y");
      const box = (await chart.boundingBox())!;
      const session = await context.newCDPSession(page);
      const from = { x: box.x + 25, y: box.y + 55 };
      const to = { x: box.x + box.width - 15, y: from.y };
      const before = await counters(page);
      await touch(session, "touchStart", [from]);
      await touch(session, "touchMove", [{ x: from.x + 60, y: from.y }]);
      await expect(chart.locator(".profile-cursor")).toBeVisible();
      await expect(page.getByTestId("trip-readout")).toContainText(/^Mile \d+/);
      await expect.poll(() => chart.evaluate((node) => Array.from({ length: 20 }, (_, id) => node.hasPointerCapture(id)).some(Boolean))).toBe(true);
      await touch(session, "touchMove", [to]);
      await expect.poll(async () => Number(await chart.getAttribute("aria-valuenow"))).toBeGreaterThan(700);
      const during = await chart.getAttribute("aria-valuenow");
      await touch(session, "touchEnd", []);
      await expect(chart).toHaveAttribute("aria-valuenow", during!);
      expect((await counters(page)).sourceUpdates).toBe(before.sourceUpdates);
      expect((await counters(page)).mapRenders).toBe(before.mapRenders);
      expect(await page.evaluate(() => (window as unknown as { haptics: number[] }).haptics.length)).toBeGreaterThan(0);
      await page.touchscreen.tap(box.x + box.width / 2, from.y);
      await expect(chart).not.toHaveAttribute("aria-valuenow", during!);
      await chart.focus();
      await page.keyboard.press("Home");
      await expect(chart).toHaveAttribute("aria-valuenow", "0");
      await page.keyboard.press("End");
      await expect(chart).toHaveAttribute("aria-valuenow", await chart.getAttribute("aria-valuemax") ?? "");
      await page.keyboard.press("Escape");
      await expect(chart.locator(".profile-cursor")).toHaveCount(0);
      await page.screenshot({ path: `test-results/touch-profile-${viewport.width}.png` });
      const body = page.locator("#trip-panel-body");
      const oldScroll = await body.evaluate((node) => node.scrollTop);
      const visible = (await chart.boundingBox())!;
      await drag(session, [{ x: visible.x + 50, y: visible.y + 60 }], [{ x: visible.x + 50, y: visible.y + 155 }]);
      await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(oldScroll);
    });

    test("reduced motion suppresses press-ring animation and both haptic hints", async ({ page, context }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await planTrip(page);
      const at = await mapPoint(page);
      const session = await context.newCDPSession(page);
      await touch(session, "touchStart", [at]);
      expect(await page.locator(".map-press-ring").evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
      await expect(page.getByTestId("checkpoint-dialog")).toBeVisible();
      await touch(session, "touchEnd", []);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      const chart = await openChart(page);
      const box = (await chart.boundingBox())!;
      await drag(session, [{ x: box.x + 20, y: box.y + 50 }], [{ x: box.x + box.width - 20, y: box.y + 50 }]);
      expect(await page.evaluate(() => (window as unknown as { haptics?: number[] }).haptics ?? [])).toEqual([]);
    });
  });
}

test("desktop mouse keeps click inspection and never starts a long press", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await planTrip(page);
  const at = await mapPoint(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator(".map-press-ring")).toBeHidden();
  await expect(page.getByTestId("checkpoint-dialog")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByTestId("checkpoint-dialog")).toBeVisible();
});
