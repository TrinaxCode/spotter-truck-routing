import { describe, expect, it } from "vitest";
import {
  buildGrid,
  createField,
  createParticleSet,
  createRng,
  createScreenMapping,
  createSpawnTable,
  easeField,
  fallbackWindFrom,
  fillField,
  fillSpawnTable,
  fitScreenMapping,
  groundToScreen,
  latToMercY,
  lonToMercX,
  mercXToLon,
  mercYToLat,
  particleBudget,
  pickSlot,
  precipDensity,
  precipIntensity,
  rainStreakPx,
  rampRgb,
  resetParticles,
  samplePrecip,
  sampleWind,
  slotAt,
  slotLat,
  slotLon,
  speedBucket,
  STATE_ALIVE,
  STATE_DYING,
  STATE_IDLE,
  stepPrecipParticles,
  stepWindParticles,
  visualSpeedPx,
  windAlpha,
  windDensity,
  windFromDegrees,
  windVector,
  type FieldSource,
  type PrecipSample,
  type WindSample,
} from "./windField";

/** A 3 x 3 block of one-degree cells; (lon -101..-99, lat 35..37). */
function cells3x3() {
  const out: { lat: number; lon: number }[] = [];
  for (let j = 0; j < 3; j += 1) for (let i = 0; i < 3; i += 1) out.push({ lon: -101 + i, lat: 35 + j });
  return out;
}

function source(count: number, wind: (number | null)[], dir?: (number | null)[], rain = 0, snow = 0): FieldSource {
  return {
    wind: Array.from({ length: count }, () => wind),
    rain: Array.from({ length: count }, () => [rain, rain]),
    snow: Array.from({ length: count }, () => [snow, snow]),
    wind_dir: dir ? Array.from({ length: count }, () => dir) : undefined,
  };
}

function gridOf(cells = cells3x3(), cellDeg = 1) {
  const grid = buildGrid(cells, cellDeg);
  if (!grid) throw new Error("grid expected");
  return grid;
}

describe("wind vector convention", () => {
  it("converts the meteorological 'from' bearing into a 'towards' vector", () => {
    const west = windVector(10, 270);
    expect(west.u).toBeCloseTo(10, 6);
    expect(west.v).toBeCloseTo(0, 6);
    const north = windVector(10, 0);
    expect(north.u).toBeCloseTo(0, 6);
    expect(north.v).toBeCloseTo(-10, 6);
    expect(windVector(10, 90).u).toBeCloseTo(-10, 6);
    expect(windVector(10, 180).v).toBeCloseTo(10, 6);
  });

  it("round-trips through windFromDegrees and keeps the speed", () => {
    for (const deg of [0, 33, 90, 181, 270, 359]) {
      const { u, v } = windVector(17, deg);
      expect(Math.hypot(u, v)).toBeCloseTo(17, 6);
      expect(windFromDegrees(u, v)).toBeCloseTo(deg, 4);
    }
  });

  it("falls back to a gentle, finite, mostly westerly bearing", () => {
    for (const [lon, lat] of [[-100, 35], [-97, 40], [-105, 32]]) {
      const from = fallbackWindFrom(lon, lat);
      expect(Number.isFinite(from)).toBe(true);
      expect(from).toBeGreaterThan(220);
      expect(from).toBeLessThan(320);
    }
  });
});

describe("mercator helpers", () => {
  it("round-trips lon/lat", () => {
    expect(mercXToLon(lonToMercX(-97.5))).toBeCloseTo(-97.5, 9);
    expect(mercYToLat(latToMercY(36.4))).toBeCloseTo(36.4, 9);
    expect(lonToMercX(0)).toBeCloseTo(0.5, 9);
  });
});

describe("grid", () => {
  it("snaps cells to slots and finds the containing cell", () => {
    const grid = gridOf();
    expect(grid.nx).toBe(3);
    expect(grid.ny).toBe(3);
    expect(slotLon(grid, grid.slotOfCell[4])).toBeCloseTo(-100, 9);
    expect(slotLat(grid, grid.slotOfCell[4])).toBeCloseTo(36, 9);
    expect(slotAt(grid, -100.2, 35.9)).toBe(grid.slotOfCell[4]);
    expect(slotAt(grid, -103, 36)).toBe(-1);
  });

  it("leaves holes where the corridor has no cell", () => {
    const grid = gridOf([{ lon: -101, lat: 35 }, { lon: -99, lat: 37 }]);
    expect(slotAt(grid, -100, 36)).toBe(-1);
    expect(slotAt(grid, -99.1, 37.1)).toBeGreaterThanOrEqual(0);
  });

  it("rejects empty or invalid input", () => {
    expect(buildGrid([], 1)).toBeNull();
    expect(buildGrid(cells3x3(), 0)).toBeNull();
    expect(buildGrid([{ lon: NaN, lat: 1 }], 1)).toBeNull();
  });
});

describe("fillField", () => {
  it("stores the towards-vector, speed and precipitation per slot", () => {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, [20, 20], [270, 270], 0.2, 0.4), 0);
    const slot = grid.slotOfCell[0];
    expect(field.windOk[slot]).toBe(1);
    expect(field.u[slot]).toBeCloseTo(20, 4);
    expect(field.v[slot]).toBeCloseTo(0, 4);
    expect(field.speed[slot]).toBeCloseTo(20, 4);
    expect(field.rain[slot]).toBeCloseTo(0.2, 6);
    expect(field.snow[slot]).toBeCloseTo(0.4, 6);
    expect(field.realDirections).toBe(9);
  });

  it("keeps the speed and uses the fallback direction when wind_dir is missing or null", () => {
    const grid = gridOf();
    const field = createField(grid);
    for (const src of [source(9, [25, 25]), source(9, [25, 25], [null, null])]) {
      fillField(field, src, 0);
      const slot = grid.slotOfCell[3];
      expect(field.windOk[slot]).toBe(1);
      expect(Math.hypot(field.u[slot], field.v[slot])).toBeCloseTo(25, 3);
      expect(field.u[slot]).toBeGreaterThan(0);
      expect(field.realDirections).toBe(0);
    }
  });

  it("marks cells without wind and treats null precipitation as dry", () => {
    const grid = gridOf();
    const field = createField(grid);
    const src: FieldSource = {
      wind: [[null, null], ...Array.from({ length: 8 }, () => [10, 10])],
      rain: Array.from({ length: 9 }, () => [null, null]),
      snow: Array.from({ length: 9 }, () => [null, null]),
    };
    fillField(field, src, 0);
    expect(field.windOk[grid.slotOfCell[0]]).toBe(0);
    expect(field.windOk[grid.slotOfCell[1]]).toBe(1);
    expect(field.rain.every((value) => value === 0)).toBe(true);
    expect(field.snow.every((value) => value === 0)).toBe(true);
  });

  it("survives short rows, missing rows and hours past the forecast", () => {
    const grid = gridOf();
    const field = createField(grid);
    const src: FieldSource = { wind: [[5]], rain: [], snow: [] };
    expect(() => fillField(field, src, 7)).not.toThrow();
    expect(field.windOk.some((flag) => flag === 1)).toBe(false);
    expect(() => fillField(field, src, Number.NaN)).not.toThrow();
  });

  it("blends fractional hours and snaps to the one available endpoint", () => {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, [10, 30], [270, 270]), 0.5);
    expect(field.speed[grid.slotOfCell[0]]).toBeCloseTo(20, 3);
    expect(field.u[grid.slotOfCell[0]]).toBeCloseTo(20, 3);
    fillField(field, source(9, [10, null], [270, null]), 0.5);
    expect(field.speed[grid.slotOfCell[0]]).toBeCloseTo(10, 3);
  });

  it("eases one field towards another and reports when it settles", () => {
    const grid = gridOf();
    const current = createField(grid);
    const target = createField(grid);
    fillField(current, source(9, [10, 10], [270, 270]), 0);
    fillField(target, source(9, [30, 30], [270, 270], 0.5), 0);
    expect(easeField(current, target, 0.5)).toBe(true);
    expect(current.speed[0]).toBeCloseTo(20, 3);
    for (let i = 0; i < 40; i += 1) easeField(current, target, 0.5);
    expect(easeField(current, target, 0.5)).toBe(false);
    expect(current.speed[0]).toBeCloseTo(30, 2);
  });
});

describe("sampling", () => {
  const wind: WindSample = { u: 0, v: 0, speed: 0 };

  it("interpolates bilinearly between cell centres", () => {
    const grid = gridOf([{ lon: -101, lat: 35 }, { lon: -100, lat: 35 }]);
    const field = createField(grid);
    const src: FieldSource = { wind: [[10], [30]], rain: [[0], [0]], snow: [[0], [0]], wind_dir: [[270], [270]] };
    fillField(field, src, 0);
    expect(sampleWind(field, -101, 35, wind)).toBe(true);
    expect(wind.u).toBeCloseTo(10, 4);
    expect(sampleWind(field, -100.5, 35, wind)).toBe(true);
    expect(wind.u).toBeCloseTo(20, 4);
    expect(wind.speed).toBeCloseTo(20, 4);
    expect(sampleWind(field, -100.25, 35, wind)).toBe(true);
    expect(wind.u).toBeCloseTo(25, 4);
  });

  it("interpolates the vector, not the angle, across a direction change", () => {
    const grid = gridOf([{ lon: -101, lat: 35 }, { lon: -100, lat: 35 }]);
    const field = createField(grid);
    const src: FieldSource = { wind: [[20], [20]], rain: [[0], [0]], snow: [[0], [0]], wind_dir: [[270], [180]] };
    fillField(field, src, 0);
    sampleWind(field, -100.5, 35, wind);
    expect(wind.u).toBeCloseTo(10, 4);
    expect(wind.v).toBeCloseTo(10, 4);
    // Speed for colour is the interpolated speed, not the shrunken vector magnitude.
    expect(wind.speed).toBeCloseTo(20, 4);
  });

  it("is false outside the corridor and in cells without wind", () => {
    const grid = gridOf();
    const field = createField(grid);
    const src: FieldSource = {
      wind: [[null], ...Array.from({ length: 8 }, () => [12])],
      rain: Array.from({ length: 9 }, () => [0]),
      snow: Array.from({ length: 9 }, () => [0]),
    };
    fillField(field, src, 0);
    expect(sampleWind(field, -120, 36, wind)).toBe(false);
    expect(sampleWind(field, -101, 35, wind)).toBe(false);
    expect(sampleWind(field, -100, 36, wind)).toBe(true);
  });

  it("renormalises over the neighbours that exist at the corridor edge", () => {
    const grid = gridOf([{ lon: -101, lat: 35 }]);
    const field = createField(grid);
    fillField(field, { wind: [[14]], rain: [[0]], snow: [[0]], wind_dir: [[270]] }, 0);
    expect(sampleWind(field, -100.8, 35.2, wind)).toBe(true);
    expect(wind.speed).toBeCloseTo(14, 4);
  });

  it("samples rain and snow over existing cells", () => {
    const grid = gridOf([{ lon: -101, lat: 35 }, { lon: -100, lat: 35 }]);
    const field = createField(grid);
    fillField(field, { wind: [[10], [10]], rain: [[0.4], [0]], snow: [[0], [2]] }, 0);
    const out: PrecipSample = { rain: 0, snow: 0 };
    expect(samplePrecip(field, -100.5, 35, out)).toBe(true);
    expect(out.rain).toBeCloseTo(0.2, 5);
    expect(out.snow).toBeCloseTo(1, 5);
    expect(samplePrecip(field, -110, 35, out)).toBe(false);
  });
});

describe("visual mappings", () => {
  it("makes calm air sparse, slow and faint, and a gale dense, fast and bold", () => {
    expect(windDensity(0)).toBe(0);
    expect(windDensity(5)).toBeLessThan(0.25);
    expect(windDensity(40)).toBe(1);
    expect(windDensity(10)).toBeGreaterThan(windDensity(5));
    expect(visualSpeedPx(3)).toBeLessThan(visualSpeedPx(30));
    expect(visualSpeedPx(0)).toBe(0);
    expect(windAlpha(2)).toBeLessThan(0.25);
    expect(windAlpha(40)).toBeGreaterThan(0.8);
  });

  it("scales precipitation density and length with intensity and is zero when dry", () => {
    expect(precipDensity("rain", 0)).toBe(0);
    expect(precipDensity("rain", 0.001)).toBe(0);
    expect(precipDensity("snow", 0.005)).toBe(0);
    expect(precipIntensity("rain", 0.02)).toBeGreaterThan(0);
    expect(precipIntensity("rain", 0.1)).toBeGreaterThan(precipIntensity("rain", 0.02));
    expect(precipIntensity("rain", 5)).toBe(1);
    expect(precipIntensity("snow", 0.5)).toBeLessThan(precipIntensity("snow", 2));
    expect(rainStreakPx(1)).toBeGreaterThan(rainStreakPx(0.1));
  });

  it("looks colours up on the heatmap wind ramp", () => {
    expect(rampRgb("wind", 0)).toEqual(rampRgb("wind", 10));
    const low = rampRgb("wind", 10);
    const high = rampRgb("wind", 60);
    expect(low).not.toEqual(high);
    expect(speedBucket(0)).toBe(0);
    expect(speedBucket(200)).toBe(11);
  });
});

describe("ground to screen mapping", () => {
  const world = 512 * 2 ** 6;

  it("recovers an affine view exactly", () => {
    const ground = [0.3, 0.4, 0.3 + 800 / world, 0.4, 0.3 + 800 / world, 0.4 + 600 / world, 0.3, 0.4 + 600 / world];
    const screen = [100, 100, 900, 100, 900, 700, 100, 700];
    const mapping = createScreenMapping();
    expect(fitScreenMapping(mapping, screen, ground, world)).toBe(true);
    const out = new Float64Array(2);
    expect(groundToScreen(mapping, 0.3 + 400 / world, 0.4 + 300 / world, out)).toBe(true);
    expect(out[0]).toBeCloseTo(500, 3);
    expect(out[1]).toBeCloseTo(400, 3);
  });

  it("recovers a perspective (pitched) view from four points", () => {
    // Ground -> screen with a known projective transform.
    const project = (gx: number, gy: number): [number, number] => {
      const a = (gx - 0.5) * world;
      const b = (gy - 0.5) * world;
      const w = 1 + 0.0009 * b;
      return [(640 + 0.9 * a + 0.1 * b) / w, (400 + 0.3 * a + 0.8 * b) / w];
    };
    const pts = [[-0.002, -0.001], [0.002, -0.001], [0.0025, 0.0012], [-0.0025, 0.0012]].map(([dx, dy]) => [0.5 + dx, 0.5 + dy]);
    const ground = pts.flat();
    const screen = pts.flatMap(([x, y]) => project(x, y));
    const mapping = createScreenMapping();
    expect(fitScreenMapping(mapping, screen, ground, world)).toBe(true);
    const probe = [0.5 + 0.0006, 0.5 + 0.0003];
    const expected = project(probe[0], probe[1]);
    const out = new Float64Array(2);
    expect(groundToScreen(mapping, probe[0], probe[1], out)).toBe(true);
    expect(out[0]).toBeCloseTo(expected[0], 3);
    expect(out[1]).toBeCloseTo(expected[1], 3);
  });

  it("rejects degenerate input", () => {
    const mapping = createScreenMapping();
    const same = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(fitScreenMapping(mapping, [0, 0, 10, 0, 10, 10, 0, 10], same, world)).toBe(false);
    expect(mapping.valid).toBe(false);
    expect(fitScreenMapping(mapping, [0, 0, 10, 0, 10, 10, 0, 10], [NaN, 0, 1, 0, 1, 1, 0, 1], world)).toBe(false);
  });
});

describe("spawn table", () => {
  it("weights slots by density x area and picks proportionally", () => {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, [30, 30], [270, 270], 0, 0), 0);
    const table = createSpawnTable(9);
    const slots = [grid.slotOfCell[0], grid.slotOfCell[1]];
    const total = fillSpawnTable(table, field, "wind", slots, [100, 300], 2);
    expect(total).toBeCloseTo(400, 3);
    expect(table.count).toBe(2);
    const rng = createRng(3);
    let second = 0;
    for (let i = 0; i < 4000; i += 1) if (pickSlot(table, rng()) === slots[1]) second += 1;
    expect(second / 4000).toBeGreaterThan(0.7);
    expect(second / 4000).toBeLessThan(0.8);
  });

  it("is empty where it is dry or calm, so nothing can spawn", () => {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, [0, 0], [270, 270], 0, 0), 0);
    const table = createSpawnTable(9);
    const slots = Array.from(grid.slotOfCell);
    const areas = slots.map(() => 100);
    expect(fillSpawnTable(table, field, "rain", slots, areas, 9)).toBe(0);
    expect(table.count).toBe(0);
    expect(pickSlot(table, 0.4)).toBe(-1);
    expect(fillSpawnTable(table, field, "wind", slots, areas, 9)).toBe(0);
  });

  it("holds more particles for heavier rain", () => {
    const grid = gridOf();
    const light = createField(grid);
    const heavy = createField(grid);
    fillField(light, source(9, [10, 10], undefined, 0.02), 0);
    fillField(heavy, source(9, [10, 10], undefined, 0.6), 0);
    const slots = Array.from(grid.slotOfCell);
    const areas = slots.map(() => 1000);
    const table = createSpawnTable(9);
    const a = fillSpawnTable(table, light, "rain", slots, areas, 9);
    const b = fillSpawnTable(table, heavy, "rain", slots, areas, 9);
    expect(b).toBeGreaterThan(a * 2);
  });
});

describe("wind particles", () => {
  function setup(windMph: number[] = [30, 30], dir: (number | null)[] = [270, 270]) {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, windMph, dir), 0);
    const table = createSpawnTable(9);
    const slots = Array.from(grid.slotOfCell);
    fillSpawnTable(table, field, "wind", slots, slots.map(() => 1000), 9);
    const set = createParticleSet(50, 8, 5);
    return { grid, field, table, set, mercPerPx: 1 / (512 * 2 ** 6) };
  }

  it("respawns idle particles inside cells that carry wind", () => {
    const { grid, field, table, set, mercPerPx } = setup();
    const rng = createRng(1);
    for (let i = 0; i < 30; i += 1) stepWindParticles(set, 50, 1 / 60, { field, table, mercPerPx, rng });
    let alive = 0;
    for (let i = 0; i < set.capacity; i += 1) {
      if (set.state[i] !== STATE_ALIVE) continue;
      alive += 1;
      expect(slotAt(grid, mercXToLon(set.x[i]), mercYToLat(set.y[i]))).toBeGreaterThanOrEqual(0);
    }
    expect(alive).toBeGreaterThan(10);
  });

  it("advects towards the wind: a westerly (from 270) moves a particle east", () => {
    const { field, table, set, mercPerPx } = setup();
    const rng = createRng(2);
    for (let i = 0; i < 30; i += 1) stepWindParticles(set, 1, 1 / 60, { field, table, mercPerPx, rng });
    expect(set.state[0]).toBe(STATE_ALIVE);
    const x0 = set.x[0];
    const y0 = set.y[0];
    stepWindParticles(set, 1, 0.1, { field, table, mercPerPx, rng });
    expect(set.state[0]).toBe(STATE_ALIVE);
    expect(set.x[0]).toBeGreaterThan(x0);
    expect(Math.abs(set.y[0] - y0)).toBeLessThan(Math.abs(set.x[0] - x0) * 1e-3);
  });

  it("moves a northerly (from 0) south, i.e. towards larger world y", () => {
    const { field, table, set, mercPerPx } = setup([30, 30], [0, 0]);
    const rng = createRng(2);
    for (let i = 0; i < 30; i += 1) stepWindParticles(set, 1, 1 / 60, { field, table, mercPerPx, rng });
    const y0 = set.y[0];
    stepWindParticles(set, 1, 0.1, { field, table, mercPerPx, rng });
    expect(set.y[0]).toBeGreaterThan(y0);
  });

  it("moves faster in stronger wind and scales with zoom (px per second)", () => {
    const slow = setup([8, 8]);
    const fast = setup([40, 40]);
    const travelled = ({ field, table, set, mercPerPx }: ReturnType<typeof setup>) => {
      set.state[0] = STATE_ALIVE;
      set.x[0] = lonToMercX(-100);
      set.y[0] = latToMercY(36);
      set.life[0] = 10;
      set.seed[0] = 0.5;
      const x0 = set.x[0];
      stepWindParticles(set, 1, 0.05, { field, table, mercPerPx, rng: createRng(4) });
      return set.x[0] - x0;
    };
    expect(travelled(fast)).toBeGreaterThan(travelled(slow) * 2);
  });

  it("builds a trail that never exceeds the history length", () => {
    const { field, table, set, mercPerPx } = setup();
    const rng = createRng(6);
    for (let i = 0; i < 400; i += 1) {
      stepWindParticles(set, 1, 1 / 60, { field, table, mercPerPx, rng });
      expect(set.histN[0]).toBeLessThanOrEqual(set.histLen);
    }
  });

  it("clips: a particle that leaves the corridor dies and its trail retracts", () => {
    const { field, table, set, mercPerPx } = setup();
    set.state[0] = STATE_ALIVE;
    set.x[0] = lonToMercX(-120);
    set.y[0] = latToMercY(36);
    set.life[0] = 5;
    set.histN[0] = 3;
    const rng = createRng(1);
    stepWindParticles(set, 1, 1 / 60, { field, table, mercPerPx, rng });
    expect(set.state[0]).toBe(STATE_DYING);
    for (let i = 0; i < 30; i += 1) stepWindParticles(set, 1, 1 / 60, { field, table: createSpawnTable(1), mercPerPx, rng });
    expect(set.state[0]).toBe(STATE_IDLE);
  });

  it("dies in a cell whose wind is null for the hour (no data, no particles)", () => {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, [null, null]), 0);
    const table = createSpawnTable(9);
    const set = createParticleSet(5, 6, 1);
    set.state[0] = STATE_ALIVE;
    set.x[0] = lonToMercX(-100);
    set.y[0] = latToMercY(36);
    set.life[0] = 5;
    stepWindParticles(set, 1, 1 / 60, { field, table, mercPerPx: 1e-5, rng: createRng(1) });
    expect(set.state[0]).toBe(STATE_DYING);
  });

  it("ends a particle at its life and parks the ones beyond the active count", () => {
    const { field, table, set, mercPerPx } = setup();
    const rng = createRng(8);
    set.state[10] = STATE_ALIVE;
    stepWindParticles(set, 5, 1 / 60, { field, table, mercPerPx, rng });
    expect(set.state[10]).toBe(STATE_IDLE);
    set.state[0] = STATE_ALIVE;
    set.x[0] = lonToMercX(-100);
    set.y[0] = latToMercY(36);
    set.age[0] = 9;
    set.life[0] = 1;
    stepWindParticles(set, 5, 1 / 60, { field, table, mercPerPx, rng });
    expect(set.state[0]).toBe(STATE_DYING);
  });

  it("only spawns where `accept` allows (e.g. on screen)", () => {
    const { field, table, set, mercPerPx } = setup();
    const rng = createRng(9);
    const limit = lonToMercX(-100);
    for (let i = 0; i < 30; i += 1) stepWindParticles(set, 50, 1 / 60, { field, table, mercPerPx, rng, accept: (x) => x < limit });
    let spawned = 0;
    for (let i = 0; i < set.capacity; i += 1) {
      if (set.state[i] === STATE_IDLE) continue;
      spawned += 1;
      // Spawned west of the limit; half a second of drift moves it a few hundredths of a degree.
      expect(set.x[i]).toBeLessThan(limit + 0.002);
    }
    expect(spawned).toBeGreaterThan(0);
  });

  it("resets cleanly", () => {
    const { set } = setup();
    set.state.fill(STATE_ALIVE);
    set.histN.fill(4);
    resetParticles(set);
    expect(set.state.every((s) => s === STATE_IDLE)).toBe(true);
    expect(set.histN.every((n) => n === 0)).toBe(true);
  });
});

describe("precipitation particles", () => {
  function setup(rain: number, snow = 0) {
    const grid = gridOf();
    const field = createField(grid);
    fillField(field, source(9, [20, 20], [270, 270], rain, snow), 0);
    const slots = Array.from(grid.slotOfCell);
    const table = createSpawnTable(9);
    return { grid, field, table, slots, set: createParticleSet(200, 0, 3), mercPerPx: 1 / (512 * 2 ** 6) };
  }

  it("spawns nothing where it is dry", () => {
    const { field, table, slots, set, mercPerPx } = setup(0);
    fillSpawnTable(table, field, "rain", slots, slots.map(() => 1000), 9);
    const rng = createRng(1);
    let alive = 0;
    for (let i = 0; i < 60; i += 1) alive = stepPrecipParticles(set, 200, 1 / 60, { field, table, mercPerPx, rng, kind: "rain", fallHeightPx: 100 });
    expect(alive).toBe(0);
  });

  it("makes rain fall, reports landings and frees the slot", () => {
    const { field, table, slots, set, mercPerPx } = setup(0.3);
    fillSpawnTable(table, field, "rain", slots, slots.map(() => 1000), 9);
    const rng = createRng(1);
    const landed: number[] = [];
    let alive = 0;
    for (let i = 0; i < 90; i += 1) {
      alive = stepPrecipParticles(set, 200, 1 / 60, { field, table, mercPerPx, rng, kind: "rain", fallHeightPx: 100 }, (_x, _y, level) => landed.push(level));
    }
    expect(alive).toBeGreaterThan(20);
    expect(landed.length).toBeGreaterThan(20);
    expect(landed.every((level) => level > 0 && level <= 1)).toBe(true);
    for (let i = 0; i < set.capacity; i += 1) {
      if (set.state[i] === STATE_ALIVE) {
        expect(set.h[i]).toBeGreaterThan(0);
        expect(set.h[i]).toBeLessThanOrEqual(100 * 1.2);
      }
    }
    // Wind from the west slants the streak to the east: positive slant.
    const slanted = Array.from(set.slant).filter((_, i) => set.state[i] === STATE_ALIVE);
    expect(slanted.every((value) => value > 0)).toBe(true);
  });

  it("falls snow slowly: far fewer landings than rain over the same time", () => {
    const rain = setup(0.3);
    const snow = setup(0, 0.8);
    fillSpawnTable(rain.table, rain.field, "rain", rain.slots, rain.slots.map(() => 1000), 9);
    fillSpawnTable(snow.table, snow.field, "snow", snow.slots, snow.slots.map(() => 1000), 9);
    let rainLandings = 0;
    let snowLandings = 0;
    const rng = createRng(2);
    for (let i = 0; i < 120; i += 1) {
      stepPrecipParticles(rain.set, 200, 1 / 60, { ...rain, rng, kind: "rain", fallHeightPx: 100 }, () => (rainLandings += 1));
      stepPrecipParticles(snow.set, 200, 1 / 60, { ...snow, rng, kind: "snow", fallHeightPx: 100 }, () => (snowLandings += 1));
    }
    expect(rainLandings).toBeGreaterThan(snowLandings * 3);
  });

  it("drops flakes that drift out of the corridor", () => {
    const { field, table, slots, set, mercPerPx } = setup(0, 0.8);
    fillSpawnTable(table, field, "snow", slots, slots.map(() => 1000), 9);
    set.state[0] = STATE_ALIVE;
    set.x[0] = lonToMercX(-130);
    set.y[0] = latToMercY(36);
    set.h[0] = 80;
    set.level[0] = 0.5;
    stepPrecipParticles(set, 1, 1 / 60, { field, table, mercPerPx, rng: createRng(1), kind: "snow", fallHeightPx: 100 });
    expect(set.state[0]).toBe(STATE_IDLE);
  });
});

describe("particle budget", () => {
  it("scales down for weak devices, dense screens and small viewports, never below 300", () => {
    const full = particleBudget({ width: 1440, height: 900, devicePixelRatio: 1, hardwareConcurrency: 12 });
    expect(full).toBe(4000);
    expect(particleBudget({ width: 1440, height: 900, devicePixelRatio: 1, hardwareConcurrency: 2 })).toBeLessThan(full);
    expect(particleBudget({ width: 1440, height: 900, devicePixelRatio: 3, hardwareConcurrency: 12 })).toBeLessThan(full);
    expect(particleBudget({ width: 390, height: 700, devicePixelRatio: 3, hardwareConcurrency: 4 })).toBeLessThan(2500);
    expect(particleBudget({ width: 100, height: 100, devicePixelRatio: 3, hardwareConcurrency: 1 })).toBeGreaterThanOrEqual(300);
    expect(particleBudget({ width: 1440, height: 900, devicePixelRatio: 1, hardwareConcurrency: 12, maxParticles: 1000 })).toBe(1000);
  });
});
