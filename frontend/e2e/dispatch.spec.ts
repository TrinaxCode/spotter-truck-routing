import { expect, test, type Page } from "@playwright/test";

async function planTrip(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Origin" })).toHaveValue(/Dallas/);
  await expect(page.getByRole("combobox", { name: "Destination" })).toHaveValue(/Denver/);
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByText("Recommended")).toBeVisible();
  await expect(page.getByTestId("route-card")).toHaveCount(3);
  await expect(page.getByTestId("trip-summary")).toContainText(/Dallas → Denver/);
  await expect(page.getByRole("combobox", { name: "Origin" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Route A/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("heatmap-slider")).toBeEnabled();
}

function boxInside(box: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
}

test("plan, select a route, slide the forecast, and open a checkpoint", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await planTrip(page);
  await expect(page.getByTestId("forecast-clock")).toContainText("At departure");

  const slider = page.getByTestId("heatmap-slider");
  await expect
    .poll(async () => page.evaluate(() => window.__spotter?.sourceUpdates ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: /Route B/ }).click();
  await expect(page.getByRole("button", { name: /Route B/ })).toHaveAttribute("aria-pressed", "true");

  const before = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
  await slider.focus();
  await slider.press("ArrowRight");
  const after = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
  expect(after.sourceUpdates).toBe(before.sourceUpdates);
  expect(after.mapRenders).toBe(before.mapRenders);
  expect(after.paintUpdates ?? 0).toBeGreaterThan(before.paintUpdates ?? 0);
  expect(after.frame).toBe((before.frame ?? 0) + 1);
  await expect(page.getByTestId("forecast-clock")).toContainText("+1 h from departure");
  await page.screenshot({ path: "test-results/layout-1280.png" });

  const selected = page.getByTestId("route-card").filter({ has: page.getByRole("button", { pressed: true }) });
  await selected.getByText(/Checkpoints/).click();
  await selected.getByTestId("checkpoint-button").first().click();
  const dialog = page.getByTestId("checkpoint-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/mi/);
  await expect(dialog).toContainText(/Wind/);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  expect(consoleErrors.join("\n")).not.toContain("Worker failed to load");
});

test("the forecast variable switches to a unit-labelled ramp without touching the map source", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await planTrip(page);
  await expect
    .poll(async () => page.evaluate(() => window.__spotter?.sourceUpdates ?? 0), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect(page.getByRole("list", { name: "Risk levels" })).toBeVisible();
  const before = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
  await page.getByRole("radio", { name: "Wind" }).click();
  await expect(page.getByRole("img", { name: /Wind scale in mph/ })).toBeVisible();
  await page.getByRole("radio", { name: "Rain" }).click();
  await expect(page.getByRole("img", { name: /Rain scale in in\/hr/ })).toBeVisible();
  const after = await page.evaluate(() => ({ ...(window.__spotter ?? {}) }));
  expect(after.sourceUpdates).toBe(before.sourceUpdates);
  expect(after.mapRenders).toBe(before.mapRenders);
  expect(after.variable).toBe("rain");
});

test("the theme toggle swaps the interface and is remembered", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Dark theme" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("the phone sheet cycles through three snaps and nothing overflows sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const sheet = page.locator("#trip-panel");
  await expect(sheet).toHaveAttribute("data-snap", "expanded");
  const handle = page.getByRole("button", { name: /trip panel/ });
  await handle.click();
  await expect(sheet).toHaveAttribute("data-snap", "collapsed");
  await handle.click();
  await expect(sheet).toHaveAttribute("data-snap", "half");
  await handle.click();
  await expect(sheet).toHaveAttribute("data-snap", "expanded");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const slider = await page.getByTestId("heatmap-slider").boundingBox();
  boxInside(slider!, 375, 812);
});

test("mobile keeps the map canvas and the forecast slider on screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /trip panel/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dark theme" })).toHaveAttribute("aria-pressed", /true|false/);
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByText("Recommended")).toBeVisible();
  await expect(page.getByTestId("heatmap-slider")).toBeEnabled();

  const map = page.getByTestId("map-canvas");
  await expect(map).toBeVisible();
  await expect(map.locator("canvas").first()).toBeVisible();
  // The map is full-bleed; after planning the sheet settles on its half snap and leaves the map in view.
  const dockBox = await page.locator(".dock").boundingBox();
  expect(dockBox).not.toBeNull();
  expect(dockBox!.y).toBeGreaterThanOrEqual(812 * 0.3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  const slider = page.getByTestId("heatmap-slider");
  const sliderBox = await slider.boundingBox();
  expect(sliderBox).not.toBeNull();
  boxInside(sliderBox!, 375, 812);
  const play = page.getByRole("button", { name: "Play forecast" });
  const playBox = await play.boundingBox();
  expect(playBox).not.toBeNull();
  boxInside(playBox!, 375, 812);
  await page.screenshot({ path: "test-results/layout-375.png" });
});

test("tablet layout keeps the map and the slider in view", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await planTrip(page);
  const mapBox = await page.getByTestId("map-canvas").boundingBox();
  expect(mapBox!.height).toBeGreaterThanOrEqual(1024 - 4);
  const sliderBox = await page.getByTestId("heatmap-slider").boundingBox();
  expect(sliderBox).not.toBeNull();
  boxInside(sliderBox!, 768, 1024);
  await page.screenshot({ path: "test-results/layout-768.png" });
});

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 },
]) {
  test(`fitBounds keeps the Start and End pins clear of the legend and controls at ${size.width}px`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(size);
    await page.goto("/");
    await page.getByRole("button", { name: "Plan routes" }).click();
    await expect(page.getByText("Recommended")).toBeVisible();
    await expect(page.locator(".map-pin")).toHaveCount(2);

    // The pins settle once fonts are loaded and the legend has its final size.
    async function violation() {
      const map = (await page.getByTestId("map-canvas").boundingBox())!;
      const overlays: { name: string; box: Box }[] = [];
      for (const selector of [
        "[data-map-overlay]",
        ".maplibregl-ctrl-top-right",
        ".maplibregl-ctrl-bottom-right",
        ".maplibregl-ctrl-bottom-left",
      ]) {
        for (const node of await page.locator(selector).all()) {
          const box = await node.boundingBox();
          if (box && box.width > 0) overlays.push({ name: selector, box });
        }
      }
      if (overlays.length < 3) return "panels or controls are missing";
      for (const name of ["Origin", "Destination"]) {
        const pin = (await page.getByRole("button", { name: new RegExp(`^${name},`) }).boundingBox())!;
        const inside =
          pin.x >= map.x && pin.y >= map.y && pin.x + pin.width <= map.x + map.width && pin.y + pin.height <= map.y + map.height;
        if (!inside) return `${name} pin leaves the map`;
        for (const overlay of overlays) if (overlaps(pin, overlay.box)) return `${name} pin overlaps ${overlay.name}`;
      }
      return "";
    }
    await expect.poll(violation, { timeout: 5_000 }).toBe("");
  });
}
