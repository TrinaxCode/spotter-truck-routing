import { expect, test, type Page } from "@playwright/test";

async function openPicker(page: Page) {
  const trigger = page.getByTestId("departure-trigger");
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(page.getByTestId("departure-panel")).toBeVisible();
  return trigger;
}

test("open the picker, choose tomorrow at 6 AM, and see that time on the trip", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await openPicker(page);
  await page.getByRole("radio", { name: "Tomorrow 6 AM" }).click();
  const summary = page.getByTestId("departure-summary");
  await expect(summary).toContainText(/Leaves \w+, \w+ \d+ · 6:00 AM/);
  const text = await summary.innerText();
  const when = text.match(/Leaves \w+, (\w+ \d+) · 6:00 AM/);
  expect(when).not.toBeNull();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plan routes" }).click();
  await expect(page.getByTestId("trip-summary")).toContainText(`${when?.[1]} 6:00 AM`);
  await expect(page.getByTestId("trip-summary")).toContainText("Dallas → Denver");
});

test("a keyboard user can set tomorrow at 6 AM and plan", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const trigger = page.getByTestId("departure-trigger");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("departure-panel")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Now", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "In 2 h", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const morning = page.getByRole("radio", { name: "Tomorrow 6 AM" });
  await expect(morning).toBeFocused();
  await expect(morning).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("departure-panel")).toBeHidden();

  for (let step = 0; step < 8; step += 1) {
    const label = await page.evaluate(() => document.activeElement?.textContent ?? "");
    if (label.includes("Plan routes")) break;
    await page.keyboard.press("Tab");
  }
  await expect(page.getByRole("button", { name: "Plan routes" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("trip-summary")).toContainText("6:00 AM");
});

test("the picker fits a 375 px screen without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const before = await page.evaluate(() => document.documentElement.scrollWidth);
  await openPicker(page);
  const box = await page.evaluate(() => {
    const panel = document.querySelector(".departure-panel");
    const trigger = document.querySelector(".departure-trigger");
    const viewport = document.documentElement.clientWidth;
    const rect = (node: Element | null) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        scroll: node.scrollWidth,
        client: node.clientWidth,
      };
    };
    return {
      viewport,
      scroll: document.documentElement.scrollWidth,
      panel: rect(panel),
      trigger: rect(trigger),
    };
  });
  expect(box.scroll).toBeLessThanOrEqual(Math.max(before, box.viewport) + 1);
  expect(box.panel).not.toBeNull();
  expect(box.trigger).not.toBeNull();
  expect(box.panel?.left).toBeGreaterThanOrEqual(-1);
  expect(box.panel?.right).toBeLessThanOrEqual(box.viewport + 1);
  expect(box.trigger?.right).toBeLessThanOrEqual(box.viewport + 1);
  expect(box.panel?.scroll ?? 0).toBeLessThanOrEqual((box.panel?.client ?? 0) + 1);
  const chip = page.getByRole("radio", { name: "Tomorrow 6 AM" });
  const chipBox = await chip.boundingBox();
  expect(chipBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});
