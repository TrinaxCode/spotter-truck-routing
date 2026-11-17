import { expect, test, type Page } from "@playwright/test";

interface WxDebug {
  mode: string;
  kind: string;
  aliveParticles: number;
  running: boolean;
  reduced: boolean;
  mappingValid: boolean;
  frames: number;
}

declare global {
  interface Window {
    __wx?: { ready: boolean; animation: { debug: () => WxDebug }; map: { jumpTo: (o: object) => void } };
  }
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/weather-animation-demo.html?basemap=plain&${query}`);
  await page.waitForFunction(() => window.__wx?.ready === true);
}

const debug = (page: Page) => page.evaluate(() => window.__wx!.animation.debug());

for (const variable of ["wind", "rain", "snow"] as const) {
  test(`${variable} particles flow over the corridor`, async ({ page }) => {
    await open(page, `variable=${variable}&hour=6&zoom=7`);
    await expect.poll(async () => (await debug(page)).aliveParticles, { timeout: 15_000 }).toBeGreaterThan(20);
    const first = await debug(page);
    expect(first.running).toBe(true);
    expect(first.mappingValid).toBe(true);
    await expect.poll(async () => (await debug(page)).frames, { timeout: 10_000 }).toBeGreaterThan(first.frames);
  });
}

test("stays attached at pitch 60 and after the camera moves", async ({ page }) => {
  await open(page, "variable=wind&hour=6&zoom=7&pitch=60&bearing=-35&center=-102.5,35.6");
  await expect.poll(async () => (await debug(page)).aliveParticles, { timeout: 15_000 }).toBeGreaterThan(20);
  await page.evaluate(() => window.__wx!.map.jumpTo({ zoom: 6, pitch: 0, bearing: 0 }));
  await expect.poll(async () => (await debug(page)).mappingValid).toBe(true);
  await expect.poll(async () => (await debug(page)).aliveParticles, { timeout: 15_000 }).toBeGreaterThan(20);
});

test("reduced motion draws a still frame and runs no animation loop", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "variable=wind&hour=6&zoom=7&reduced=1");
  await page.waitForTimeout(800);
  const state = await debug(page);
  expect(state.running).toBe(false);
  expect(state.reduced).toBe(true);
  expect(state.aliveParticles).toBe(0);
});
