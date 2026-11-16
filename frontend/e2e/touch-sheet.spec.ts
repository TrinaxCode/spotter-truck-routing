import { expect, test, type CDPSession, type Page } from "@playwright/test";

type Point = { x: number; y: number };

async function planTrip(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByTestId("route-card")).toHaveCount(3);
  await expect(page.getByTestId("heatmap-slider")).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => window.__spotter?.sourceUpdates ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
}

async function touch(session: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point, id) => ({ ...point, id, radiusX: 3, radiusY: 3, force: 1 })),
  });
}

/** Release speed is read from performance.now, so the test clock makes a flick and a slow drag deterministic.
 *  Chrome keeps now on the performance instance, so patching the prototype does not change it. */
async function withClock(page: Page, run: (at: (ms: number) => Promise<void>) => Promise<void>) {
  const installed = await page.evaluate(() => {
    const original = performance.now.bind(performance);
    let t = 10_000;
    try {
      Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => t });
    } catch {
      return false;
    }
    if (performance.now() !== t) return false;
    (window as unknown as { __sheetClock?: { set: (n: number) => void; restore: () => void } }).__sheetClock = {
      set(n: number) {
        t = n;
      },
      restore() {
        Object.defineProperty(performance, "now", { configurable: true, writable: true, value: original });
      },
    };
    return true;
  });
  if (!installed) throw new Error("performance.now could not be stubbed on the page");
  const at = (ms: number) =>
    page.evaluate((n) => {
      (window as unknown as { __sheetClock: { set: (v: number) => void } }).__sheetClock.set(n);
    }, ms);
  try {
    await run(at);
  } finally {
    await page.evaluate(() => {
      (window as unknown as { __sheetClock?: { restore: () => void } }).__sheetClock?.restore();
    });
  }
}

async function slowDrag(page: Page, session: CDPSession, from: Point, to: Point) {
  await withClock(page, async (at) => {
    const steps = 12;
    await at(10_000);
    await touch(session, "touchStart", [from]);
    for (let i = 1; i <= steps; i += 1) {
      await at(10_000 + i * 40);
      await touch(session, "touchMove", [{
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      }]);
    }
    await at(10_000 + steps * 40 + 80);
    await touch(session, "touchMove", [{ x: to.x, y: to.y + 1 }]);
    await at(10_000 + steps * 40 + 180);
    await touch(session, "touchMove", [to]);
    await touch(session, "touchEnd", []);
  });
}

async function flick(page: Page, session: CDPSession, from: Point, to: Point) {
  await withClock(page, async (at) => {
    await at(20_000);
    await touch(session, "touchStart", [from]);
    await at(20_028);
    await touch(session, "touchMove", [to]);
    await touch(session, "touchEnd", []);
  });
}

/** A point on the control that is inside the sheet's scrollport, not under the timeline. */
async function pointInSheet(locator: ReturnType<Page["locator"]>): Promise<Point> {
  await locator.scrollIntoViewIfNeeded();
  const point = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const scroller = node.closest(".panel-scroll");
    const bounds = scroller?.getBoundingClientRect();
    const top = Math.max(rect.top, bounds?.top ?? rect.top);
    const bottom = Math.min(rect.bottom, bounds?.bottom ?? rect.bottom);
    if (bottom - top < 8 || rect.width < 8) return null;
    return { x: rect.left + rect.width / 2, y: top + (bottom - top) / 2 };
  });
  if (!point) throw new Error("control is outside the sheet scrollport");
  return point;
}

async function centerOf(locator: ReturnType<Page["locator"]>): Promise<Point> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("missing box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("touch sheet and controls", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("the phone sheet follows a drag, snaps on release, and still cycles from the button", async ({ page, context }) => {
    await page.goto("/");
    const sheet = page.locator("#trip-panel");
    const handle = page.getByRole("button", { name: /trip panel/ });
    await expect(sheet).toHaveAttribute("data-snap", "expanded");
    const handleBox = await handle.boundingBox();
    expect(handleBox!.height).toBeGreaterThanOrEqual(44);
    expect(handleBox!.width).toBeGreaterThanOrEqual(44);

    await handle.focus();
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveAttribute("data-snap", "collapsed");
    await page.keyboard.press("Space");
    await expect(sheet).toHaveAttribute("data-snap", "half");
    const handleAt = await centerOf(handle);
    await page.touchscreen.tap(handleAt.x, handleAt.y);
    await expect(sheet).toHaveAttribute("data-snap", "expanded");

    const travel = await page.evaluate(() => {
      const panel = document.getElementById("trip-panel")!;
      const previous = panel.style.height;
      panel.style.height = "62dvh";
      const expanded = panel.getBoundingClientRect().height;
      panel.style.height = "36dvh";
      const half = panel.getBoundingClientRect().height;
      panel.style.height = previous;
      return expanded - half;
    });
    const from = await centerOf(handle);
    const session = await context.newCDPSession(page);
    const slowDy = Math.round(travel * 0.65);
    await withClock(page, async (at) => {
      await at(10_000);
      await touch(session, "touchStart", [from]);
      await at(10_040);
      const mid = { x: from.x, y: from.y + slowDy };
      await touch(session, "touchMove", [mid]);
      const dragging = await sheet.evaluate((node) => ({
        dragging: node.getAttribute("data-dragging"),
        height: (node as HTMLElement).style.height,
        transform: (node as HTMLElement).style.transform,
        willChange: (node as HTMLElement).style.willChange,
      }));
      expect(dragging.dragging).toBe("true");
      expect(dragging.height.endsWith("px")).toBe(true);
      expect(dragging.willChange).toBe("transform");
      const translated = Number(/translateY\(([-\d.]+)px\)/.exec(dragging.transform)?.[1]);
      expect(translated).toBeGreaterThan(slowDy * 0.85);
      expect(translated).toBeLessThan(slowDy * 1.05);
      // A repeat of the same point is dropped, so the dwell has to move. 1px over 160ms stays under a flick.
      await at(10_120);
      await touch(session, "touchMove", [{ x: mid.x, y: mid.y + 1 }]);
      await at(10_280);
      await touch(session, "touchMove", [mid]);
      await touch(session, "touchEnd", []);
    });
    await expect(sheet).toHaveAttribute("data-snap", "half");

    await page.touchscreen.tap((await centerOf(handle)).x, (await centerOf(handle)).y);
    await expect(sheet).toHaveAttribute("data-snap", "expanded");
    const flickFrom = await centerOf(handle);
    await flick(page, session, flickFrom, { x: flickFrom.x, y: flickFrom.y + Math.max(28, Math.round(travel * 0.25)) });
    await expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("pulling the sheet body down drags it only from the top of the scroll", async ({ page, context }) => {
    await planTrip(page);
    const sheet = page.locator("#trip-panel");
    const body = page.locator("#trip-panel-body");
    await expect(sheet).toHaveAttribute("data-snap", "half");
    await expect.poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight + 8)).toBe(true);

    await body.evaluate((node) => {
      node.scrollTop = 160;
    });
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(1);
    const session = await context.newCDPSession(page);
    const from = await centerOf(body);
    const before = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    await slowDrag(page, session, from, { x: from.x, y: from.y + 140 });
    await expect(sheet).toHaveAttribute("data-snap", "half");
    const afterScroll = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    expect(afterScroll.sourceUpdates).toBe(before.sourceUpdates);
    expect(afterScroll.mapRenders).toBe(before.mapRenders);

    await body.evaluate((node) => {
      node.scrollTop = 0;
    });
    const top = await centerOf(body);
    await slowDrag(page, session, { x: top.x, y: top.y - 20 }, { x: top.x, y: top.y + 150 });
    await expect(sheet).toHaveAttribute("data-snap", "collapsed");
    const after = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    expect(after.sourceUpdates).toBe(before.sourceUpdates);
    expect(after.mapRenders).toBe(before.mapRenders);
  });

  test("a horizontal swipe selects the neighbouring route and a vertical one does not", async ({ page, context }) => {
    await planTrip(page);
    const pressed = () => page.locator("button.route-main[aria-pressed='true']");
    await expect(pressed()).toContainText("Route A");
    const card = page.getByTestId("route-card").first();
    const from = await pointInSheet(card.locator("button.route-main"));
    const session = await context.newCDPSession(page);
    await touch(session, "touchStart", [from]);
    await touch(session, "touchMove", [{ x: from.x - 70, y: from.y + 2 }]);
    await touch(session, "touchEnd", []);
    await expect(pressed()).toContainText("Route C");

    const back = await pointInSheet(page.locator("button.route-main", { hasText: "Route C" }));
    await touch(session, "touchStart", [back]);
    await touch(session, "touchMove", [{ x: back.x + 70, y: back.y + 2 }]);
    await touch(session, "touchEnd", []);
    await expect(pressed()).toContainText("Route A");

    const stay = await pointInSheet(page.locator("button.route-main", { hasText: "Route A" }));
    await touch(session, "touchStart", [stay]);
    await touch(session, "touchMove", [{ x: stay.x + 70, y: stay.y }]);
    await touch(session, "touchEnd", []);
    await expect(pressed()).toContainText("Route A");

    const down = await pointInSheet(card.locator("button.route-main"));
    await touch(session, "touchStart", [down]);
    await touch(session, "touchMove", [{ x: down.x + 4, y: down.y + 50 }]);
    await touch(session, "touchEnd", []);
    await expect(pressed()).toContainText("Route A");
  });

  test("dragging across the departure bars scrubs the hour and leaves Apply as a button", async ({ page, context }) => {
    await planTrip(page);
    const strip = page.getByRole("radiogroup", { name: "Departure time, next 24 hours" });
    await strip.scrollIntoViewIfNeeded();
    const box = (await strip.boundingBox())!;
    const index = 3;
    const from = { x: box.x + 4, y: box.y + box.height / 2 };
    const to = { x: box.x + (box.width * (index + 0.5)) / 25, y: from.y };
    const session = await context.newCDPSession(page);
    await touch(session, "touchStart", [from]);
    await touch(session, "touchMove", [to]);
    const bar = page.locator("[data-testid='departure-bar'][data-offset='3']");
    await expect(bar).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("departure-detail")).toContainText("+3 h");
    await touch(session, "touchEnd", []);
    await expect(bar).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("apply-picked")).toBeVisible();
    await expect(page.getByTestId("apply-suggestion")).toBeVisible();

    const again = await centerOf(strip);
    await touch(session, "touchStart", [again]);
    await touch(session, "touchMove", [{ x: again.x + 3, y: again.y + 48 }]);
    await touch(session, "touchEnd", []);
    await expect(bar).toHaveAttribute("aria-checked", "true");
  });

  test("a timeline swipe steps the forecast without rewriting the route source", async ({ page, context }) => {
    await planTrip(page);
    const clock = page.getByTestId("forecast-clock");
    const before = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    const from = await centerOf(clock);
    const session = await context.newCDPSession(page);
    await touch(session, "touchStart", [from]);
    await touch(session, "touchMove", [{ x: from.x - 36, y: from.y + 2 }]);
    await touch(session, "touchEnd", []);
    await expect(clock).toContainText("+1 h from departure");
    const after = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    expect(after.sourceUpdates).toBe(before.sourceUpdates);
    expect(after.mapRenders).toBe(before.mapRenders);
    expect(after.paintUpdates ?? 0).toBeGreaterThan(before.paintUpdates ?? 0);
    expect(after.frame).toBe((before.frame ?? 0) + 1);
    expect(after.truckUpdates ?? 0).toBe(before.truckUpdates ?? 0);

    const slider = page.getByTestId("heatmap-slider");
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(clock).toContainText("+2 h from departure");

    const up = await centerOf(clock);
    await touch(session, "touchStart", [up]);
    await touch(session, "touchMove", [{ x: up.x + 2, y: up.y - 48 }]);
    await touch(session, "touchEnd", []);
    await expect(clock).toContainText("+2 h from departure");
    await expect(page.getByRole("button", { name: "Show heatmap" })).toHaveAttribute("aria-pressed", "true");

    await touch(session, "touchStart", [up, { x: up.x + 40, y: up.y }]);
    await touch(session, "touchEnd", []);
    await expect(clock).toContainText("+2 h from departure");
    await expect(page.getByRole("button", { name: "Show heatmap" })).toHaveAttribute("aria-pressed", "true");

    const thumb = await page.locator(".slider").evaluate((node) => {
      const input = node.querySelector("input");
      const style = input ? getComputedStyle(input, "::-webkit-slider-thumb") : null;
      return {
        variable: getComputedStyle(node).getPropertyValue("--thumb").trim(),
        width: style?.width ?? "",
        height: style?.height ?? "",
      };
    });
    expect(parseFloat(thumb.variable)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(thumb.width)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(thumb.height)).toBeGreaterThanOrEqual(44);
  });

  test("reduced motion still snaps the sheet", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const sheet = page.locator("#trip-panel");
    const from = await centerOf(page.getByRole("button", { name: /trip panel/ }));
    const session = await context.newCDPSession(page);
    await slowDrag(page, session, from, { x: from.x, y: from.y + 150 });
    await expect(sheet).toHaveAttribute("data-snap", "half");
  });
});

test.describe("touch controls on a tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("route and sheet swipes stay on the phone, and the strip, timeline and thumb still work", async ({ page, context }) => {
    await planTrip(page);
    await expect(page.getByRole("button", { name: /trip panel/ })).toHaveCount(0);
    await expect(page.locator("#trip-panel")).toHaveAttribute("data-snap", "half");

    const pressed = () => page.locator("button.route-main[aria-pressed='true']");
    await expect(pressed()).toContainText("Route A");
    const card = page.getByTestId("route-card").first();
    await card.scrollIntoViewIfNeeded();
    const from = await centerOf(card.locator("button.route-main"));
    const session = await context.newCDPSession(page);
    await touch(session, "touchStart", [from]);
    await touch(session, "touchMove", [{ x: from.x - 80, y: from.y }]);
    await touch(session, "touchEnd", []);
    await expect(pressed()).toContainText("Route A");
    await expect(page.locator("#trip-panel")).toHaveAttribute("data-snap", "half");

    const strip = page.getByRole("radiogroup", { name: "Departure time, next 24 hours" });
    await strip.scrollIntoViewIfNeeded();
    const box = (await strip.boundingBox())!;
    await touch(session, "touchStart", [{ x: box.x + 4, y: box.y + box.height / 2 }]);
    await touch(session, "touchMove", [{ x: box.x + (box.width * 3.5) / 25, y: box.y + box.height / 2 }]);
    await touch(session, "touchEnd", []);
    await expect(page.locator("[data-testid='departure-bar'][data-offset='3']")).toHaveAttribute("aria-checked", "true");

    const before = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    const clock = await centerOf(page.getByTestId("forecast-clock"));
    await touch(session, "touchStart", [clock]);
    await touch(session, "touchMove", [{ x: clock.x - 36, y: clock.y }]);
    await touch(session, "touchEnd", []);
    await expect(page.getByTestId("forecast-clock")).toContainText("+1 h from departure");
    const after = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
    expect(after.sourceUpdates).toBe(before.sourceUpdates);
    expect(after.mapRenders).toBe(before.mapRenders);
    expect(after.paintUpdates ?? 0).toBeGreaterThan(before.paintUpdates ?? 0);

    const thumb = await page.locator(".slider").evaluate((node) => getComputedStyle(node).getPropertyValue("--thumb").trim());
    expect(parseFloat(thumb)).toBeGreaterThanOrEqual(44);
  });
});
