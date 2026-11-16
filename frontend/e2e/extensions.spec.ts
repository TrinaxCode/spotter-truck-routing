import { expect, test, type Page } from "@playwright/test";

type Probe = {
  sourceUpdates: number;
  paintUpdates: number;
  truckUpdates: number;
  featureStateUpdates: number;
  mapRenders: number;
  frame: number;
  truck3d?: boolean;
  chase?: boolean;
};

const probe = (page: Page) => page.evaluate(() => ({ ...window.__spotter }) as Probe);

async function planTrip(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByTestId("route-card")).toHaveCount(3);
  await expect(page.getByTestId("heatmap-slider")).toBeEnabled();
  await expect(page.getByTestId("departure-bar")).toHaveCount(25);
  // The map draws the routes a moment after the panel; wait for its first source write.
  await expect.poll(async () => (await probe(page)).sourceUpdates, { timeout: 20_000 }).toBeGreaterThan(0);
}

test.describe("best time to leave", () => {
  test("renders the 25-hour strip and Apply re-plans with the suggested departure", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);

    const bars = page.getByTestId("departure-bar");
    await expect(bars.first()).toHaveAttribute("aria-checked", "true");
    await expect(bars.first()).toHaveAccessibleName(/^Planned departure · .* · Route A · .* mi Severe or worse · .* mi High$/);
    await expect(bars.nth(8)).toHaveAccessibleName(/^\+8 h · .* · Route A .* · suggested$/);
    // Taller bars carry more risky miles.
    const heights = await bars.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector<HTMLElement>(".strip-fill")!.getBoundingClientRect().height),
    );
    expect(heights[0]).toBeGreaterThan(heights[10] * 3);

    const suggestion = page.getByTestId("departure-suggestion");
    await expect(suggestion).toContainText("Leave 8 h later on Route A");
    const before = await page.getByTestId("trip-summary").innerText();

    // Keyboard: the Apply button is reachable and operable without a pointer.
    const apply = page.getByTestId("apply-suggestion");
    await apply.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("route-card")).toHaveCount(3, { timeout: 20_000 });
    await expect(page.getByTestId("trip-summary")).not.toHaveText(before);
    await expect(page.getByTestId("trip-summary")).toContainText(/Dallas → Denver/);
    await expect(page.getByTestId("trip-summary")).toContainText(/35,000 lb · every 25 mi/);
    // The window slid with the new departure; leaving then is already the best.
    await expect(page.getByTestId("departure-stay")).toContainText("is already the lowest-risk option in the next 24 h.");
    await expect(page.getByTestId("departure-bar")).toHaveCount(25);
  });

  test("picking another hour offers to plan for it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);
    await page.getByTestId("departure-bar").nth(3).click();
    await expect(page.getByTestId("departure-detail")).toContainText(/^\+3 h/);
    await expect(page.getByTestId("apply-picked")).toBeVisible();
  });
});

test.describe("weather profile", () => {
  test("hovering and arrow keys ring the nearest checkpoint without touching any source", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);
    const chart = page.getByTestId("weather-profile");
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator("svg")).toBeVisible();
    await expect(chart.locator(".profile-stop")).toHaveCount(2);

    const before = await probe(page);
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.4, box.y + 60);
    await expect(page.getByTestId("trip-readout")).toContainText(/^Mile \d+ · .* · Wind .* mph · \w+/);
    await expect.poll(async () => (await probe(page)).featureStateUpdates).toBeGreaterThan(before.featureStateUpdates);
    const hover = await probe(page);
    expect(hover.sourceUpdates).toBe(before.sourceUpdates);
    expect(hover.truckUpdates).toBe(before.truckUpdates);
    expect(hover.mapRenders).toBe(before.mapRenders);

    await page.mouse.move(box.x + box.width * 0.9, box.y + 60);
    await expect.poll(async () => (await probe(page)).featureStateUpdates).toBeGreaterThan(hover.featureStateUpdates);
    await page.mouse.move(2, 2);
    await expect(page.getByTestId("trip-readout")).toContainText(/Play the trip/);

    await chart.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(chart).toHaveAttribute("aria-valuetext", /^Mile \d+ · /);
    const keyed = await probe(page);
    expect(keyed.sourceUpdates).toBe(before.sourceUpdates);
  });
});

test.describe("trip playback", () => {
  test("moves the truck and the heatmap hour while only the truck source is written", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);
    await page.getByTestId("trip-profile").scrollIntoViewIfNeeded();
    await page.getByRole("radio", { name: /4x speed/ }).click();

    const slider = page.getByTestId("heatmap-slider");
    const before = await probe(page);
    await page.getByTestId("trip-play").click();
    await expect(page.getByTestId("trip-play")).toHaveAttribute("aria-pressed", "true");
    // The forecast slider steps aside while the truck drives it.
    await expect(slider).toBeDisabled();

    await expect.poll(async () => Number(await slider.inputValue()), { timeout: 15_000 }).toBeGreaterThan(2);
    const during = await probe(page);
    expect(during.truckUpdates).toBeGreaterThan(before.truckUpdates + 5);
    expect(during.sourceUpdates).toBe(before.sourceUpdates);
    expect(during.mapRenders).toBe(before.mapRenders);
    expect(during.paintUpdates).toBeGreaterThan(before.paintUpdates);
    expect(during.frame).toBeGreaterThan(2);
    await expect(page.getByTestId("trip-readout")).toContainText(/^Mile \d+ · .* · Wind .* mph · \w+/);
    await expect(page.getByTestId("forecast-clock")).toContainText(/from departure/);

    // Pausing stops the writes; the slider is usable again and keeps the truck's hour.
    await page.getByTestId("trip-play").click();
    await expect(slider).toBeEnabled();
    const paused = await probe(page);
    await page.waitForTimeout(400);
    expect((await probe(page)).truckUpdates).toBe(paused.truckUpdates);

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect((await probe(page)).sourceUpdates).toBe(before.sourceUpdates);
  });

  test("shows the break badge while the truck is parked and a route change stops the trip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);
    await page.getByTestId("trip-profile").scrollIntoViewIfNeeded();
    await page.getByRole("radio", { name: /4x speed/ }).click();
    await page.getByTestId("trip-play").click();
    await expect(page.getByTestId("stop-badge")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("stop-badge")).toHaveText(/30-min break|10-h rest/);

    await page.locator("button.route-main", { hasText: "Route B" }).click();
    await expect(page.getByTestId("trip-profile")).toContainText("Along Route B");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("heatmap-slider")).toBeEnabled();
    const settled = await probe(page);
    await page.waitForTimeout(300);
    expect((await probe(page)).truckUpdates).toBe(settled.truckUpdates);
  });

  test("steps checkpoint by checkpoint when the visitor prefers reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);
    await page.getByTestId("trip-profile").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("trip-play")).toHaveCount(0);
    const before = await probe(page);
    await page.getByRole("button", { name: "Start trip" }).click();
    await page.getByRole("button", { name: "Next checkpoint" }).click();
    await page.getByRole("button", { name: "Next checkpoint" }).click();
    await expect(page.getByTestId("trip-readout")).toContainText(/^Mile 50 · /);
    const after = await probe(page);
    expect(after.truckUpdates).toBe(before.truckUpdates + 3);
    expect(after.sourceUpdates).toBe(before.sourceUpdates);
  });
});

test.describe("phone layout", () => {
  test("strip, profile and controls fit 375 px without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect(page.getByTestId("departure-bar")).toHaveCount(25);
    await page.getByRole("button", { name: /trip panel/ }).click();

    const inside = async (selector: string) => {
      const target = page.locator(selector).first();
      await target.scrollIntoViewIfNeeded();
      const box = (await target.boundingBox())!;
      expect(box.x, selector).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, selector).toBeLessThanOrEqual(375.5);
    };
    for (const selector of [".strip-wrap", ".depart-callout", ".trip-card", ".profile-chart svg", ".trip-controls", ".trip-readout"]) {
      await inside(selector);
    }
    // Every strip bar is a real, separate target at this width.
    const bars = await page.getByTestId("departure-bar").evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { x: box.x, width: box.width, height: box.height };
      }),
    );
    for (const [index, bar] of bars.entries()) {
      expect(bar.width).toBeGreaterThanOrEqual(10);
      expect(bar.height).toBeGreaterThanOrEqual(44);
      if (index > 0) expect(bar.x).toBeGreaterThanOrEqual(bars[index - 1].x + bars[index - 1].width - 0.5);
    }

    await page.getByTestId("trip-play").click();
    await page.waitForTimeout(600);
    // Driving folds the sheet away and floats the HUD over the map; it must fit the phone too.
    await inside('[data-testid="drive-hud"]');
    const widths = await page.evaluate(() => {
      const scroller = document.getElementById("trip-panel-body")!;
      return { page: document.documentElement.scrollWidth, scroller: scroller.scrollWidth - scroller.clientWidth };
    });
    expect(widths.page).toBeLessThanOrEqual(375);
    expect(widths.scroller).toBeLessThanOrEqual(0);

  });
});

test.describe("drive mode", () => {
  test("Drive starts a 3D truck with a chase camera and a HUD; dragging the map hands the camera back", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await planTrip(page);
    const before = await probe(page);
    await page.getByTestId("drive-start").click();

    const hud = page.getByTestId("drive-hud");
    await expect(hud).toBeVisible();
    await expect(hud).toContainText(/Mile \d+ · .* to go/);
    await expect.poll(async () => (await probe(page)).truck3d, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await probe(page)).chase).toBe(true);
    await expect(hud.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "true");
    // Following the truck moves the camera, never the data sources.
    expect((await probe(page)).sourceUpdates).toBe(before.sourceUpdates);

    const canvas = page.locator(".map-canvas canvas").first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await probe(page)).chase).toBe(false);
    await expect(hud.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");

    await hud.getByRole("button", { name: "Stop trip" }).click();
    await expect(hud).toHaveCount(0);
    await expect(page.getByTestId("drive-start")).toBeVisible();
  });
});
