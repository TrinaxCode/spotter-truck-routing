import { describe, expect, it } from "vitest";
import { nextFullHourInput } from "./time";
import {
  DAY_COUNT,
  REASON_EARLY,
  REASON_GAP,
  REASON_LATE,
  clampToWindow,
  classifySlot,
  dayStrip,
  explainDisabledHours,
  hourSlots,
  minuteSlots,
  nextEnabledIndex,
  parseLocalInput,
  quickPicks,
  resolveSelection,
  summaryLine,
  triggerLabel,
  type HourOption,
} from "./departurePicker";

const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
const dstProbe = nodeProcess.env.SPOTTER_DST_PROBE === "1";

/** Vite rewrites `new URL("./rel", import.meta.url)`, so resolve the test file by hand. */
function pathFromFileUrl(fileUrl: string): string {
  return decodeURIComponent(new URL(fileUrl).pathname);
}

function resolveFrom(file: string, relative: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function zoneName(date: Date): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

describe.skipIf(dstProbe)("departure picker logic", () => {
  it("moves quick picks across midnight without losing the clock time", () => {
    const now = new Date(2026, 10, 16, 23, 20);
    const picks = quickPicks(now);
    expect(picks.map((pick) => pick.label)).toEqual(["Now", "In 2 h", "Tomorrow 8 PM", "Tomorrow 6 AM"]);
    expect(picks.map((pick) => pick.value)).toEqual([
      "2026-11-17T00:00",
      "2026-11-17T02:00",
      "2026-11-17T20:00",
      "2026-11-17T06:00",
    ]);
    expect(picks.every((pick) => !pick.disabled)).toBe(true);
    expect(picks[0]?.value).toBe(nextFullHourInput(now));
  });

  it("calls 8 PM tonight until that moment, then tomorrow", () => {
    const before = quickPicks(new Date(2026, 10, 16, 19, 59));
    expect(before.find((pick) => pick.id === "tonight")).toMatchObject({
      label: "Tonight 8 PM",
      value: "2026-11-16T20:00",
    });
    const exact = quickPicks(new Date(2026, 10, 16, 20, 0, 0));
    expect(exact.find((pick) => pick.id === "tonight")?.label).toBe("Tonight 8 PM");
    const past = quickPicks(new Date(2026, 10, 16, 20, 0, 1));
    expect(past.find((pick) => pick.id === "tonight")).toMatchObject({
      label: "Tomorrow 8 PM",
      value: "2026-11-17T20:00",
    });
  });

  it("crosses a month boundary on the calendar, not by adding 24 hours", () => {
    const now = new Date(2026, 10, 30, 23, 30);
    const picks = quickPicks(now);
    expect(picks.find((pick) => pick.id === "now")?.value).toBe("2026-12-01T00:00");
    expect(picks.find((pick) => pick.id === "plus-2h")?.value).toBe("2026-12-01T02:00");
    expect(picks.find((pick) => pick.id === "tomorrow-morning")?.value).toBe("2026-12-01T06:00");
    const parsed = parseLocalInput("2026-12-01T06:00");
    expect(parsed?.getHours()).toBe(6);
    expect(parsed?.getDate()).toBe(1);
  });

  it("builds the next 15 calendar days and labels today and tomorrow", () => {
    const now = new Date(2026, 10, 16, 10, 15);
    const days = dayStrip(now);
    expect(days).toHaveLength(DAY_COUNT);
    expect(days[0]).toMatchObject({ key: "2026-11-16", relation: "Today", day: 16, disabled: false });
    expect(days[1]).toMatchObject({ key: "2026-11-17", relation: "Tomorrow", day: 17 });
    expect(days[2]?.relation).toBeNull();
    expect(days[14]?.key).toBe("2026-11-30");
    expect(days.every((day) => !day.disabled)).toBe(true);
  });

  it("carries the strip into the next month", () => {
    const days = dayStrip(new Date(2026, 0, 25, 10, 15));
    expect(days[0]?.key).toBe("2026-01-25");
    expect(days[14]?.key).toBe("2026-02-08");
    expect(days[14]?.day).toBe(8);
  });

  it("disables hours and minutes outside now − 1 h … now + 14 days", () => {
    const now = new Date(2026, 10, 16, 10, 15);
    const hours = hourSlots("2026-11-16", 0, now);
    expect(hours.find((slot) => slot.hour === 8)).toMatchObject({ disabled: true, reason: REASON_EARLY });
    expect(hours.find((slot) => slot.hour === 9)?.disabled).toBe(false);
    expect(hours.find((slot) => slot.hour === 11)?.disabled).toBe(false);
    const earlyMinutes = minuteSlots("2026-11-16", 9, 0, now);
    expect(earlyMinutes.find((slot) => slot.minute === 0)).toMatchObject({ disabled: true, reason: REASON_EARLY });
    expect(earlyMinutes.find((slot) => slot.minute === 15)?.disabled).toBe(false);

    const last = hourSlots("2026-11-30", 0, now);
    expect(last.find((slot) => slot.hour === 10)?.disabled).toBe(false);
    expect(last.find((slot) => slot.hour === 11)).toMatchObject({ disabled: true, reason: REASON_LATE });
    const lateMinutes = minuteSlots("2026-11-30", 10, 0, now);
    expect(lateMinutes.find((slot) => slot.minute === 15)?.disabled).toBe(false);
    expect(lateMinutes.find((slot) => slot.minute === 30)).toMatchObject({ disabled: true, reason: REASON_LATE });
    expect(explainDisabledHours(hours)).toBe("12 AM\u20138 AM are before the one-hour window.");
    expect(explainDisabledHours(last)).toBe("11 AM\u201311 PM are past the 14-day forecast.");
  });

  it("names non-contiguous disabled hours", () => {
    const slots: HourOption[] = [0, 1, 3, 5].map((hour) => ({
      hour,
      label: "",
      disabled: true,
      reason: REASON_EARLY,
    }));
    expect(explainDisabledHours(slots)).toBe("12 AM\u20131 AM, 3 AM, and 5 AM are before the one-hour window.");
  });

  it("clamps to the nearest quarter inside the window and keeps a legal off-quarter time", () => {
    const now = new Date(2026, 10, 16, 10, 20);
    expect(clampToWindow("2026-11-16T08:00", now)).toBe("2026-11-16T09:30");
    expect(clampToWindow("2026-11-16T10:07", now)).toBe("2026-11-16T10:07");
    expect(clampToWindow("2026-12-01T00:00", now)).toBe("2026-11-30T10:15");
    expect(clampToWindow("not-a-time", now)).toBe("2026-11-16T09:30");
    expect(classifySlot("2026-11-16", 9, 15, now).disabled).toBe(true);
    expect(classifySlot("2026-11-16", 9, 30, now).disabled).toBe(false);
  });

  it("resolves a closed hour to the nearest open slot on that day", () => {
    const now = new Date(2026, 10, 16, 10, 15);
    expect(resolveSelection("2026-11-16", 11, 0, now)).toBe("2026-11-16T11:00");
    expect(resolveSelection("2026-11-16", 8, 0, now)).toBe("2026-11-16T09:15");
    expect(resolveSelection("2026-11-17", 11, 0, now)).toBe("2026-11-17T11:00");
  });

  it("summarises the local clock, zone, and how far away it is", () => {
    const when = new Date(2026, 10, 18, 6, 0);
    const now = new Date(2026, 10, 17, 21, 0);
    expect(summaryLine("2026-11-18T06:00", now)).toBe(
      `Leaves Wed, Nov 18 · 6:00 AM ${zoneName(when)} · in 9 h`,
    );
    expect(summaryLine("2026-11-16T12:30", new Date(2026, 10, 16, 13, 20))).toMatch(/50 min ago$/);
    expect(triggerLabel("2026-11-18T06:00")).toBe("Wed, Nov 18 · 6:00 AM");
    expect(summaryLine("nope", now)).toBe("Choose a departure time.");
    expect(triggerLabel("nope")).toBe("Choose a departure");
  });

  it("wraps arrow movement onto the next enabled slot", () => {
    const enabled = [true, false, false, true];
    expect(nextEnabledIndex(0, 1, enabled)).toBe(3);
    expect(nextEnabledIndex(3, 1, enabled)).toBe(0);
    expect(nextEnabledIndex(3, -1, enabled)).toBe(0);
    expect(nextEnabledIndex(0, 4, [false, false, false, false])).toBe(0);
  });

  it("keeps 6 AM on the next calendar day in America/Chicago, including the spring-forward", async () => {
    const specifier = "node:child_process";
    const { spawnSync } = (await import(specifier)) as {
      spawnSync: (
        command: string,
        args: readonly string[],
        options: {
          cwd: string;
          env: Record<string, string>;
          encoding: "utf8";
          timeout: number;
        },
      ) => { status: number | null; stdout: string; stderr: string };
    };
    const testFile = pathFromFileUrl(import.meta.url);
    const frontendRoot = resolveFrom(testFile, "../..");
    const vitestBin = resolveFrom(testFile, "../../node_modules/.bin/vitest");
    const env: Record<string, string> = { TZ: "America/Chicago", SPOTTER_DST_PROBE: "1", FORCE_COLOR: "0" };
    for (const [key, value] of Object.entries(nodeProcess.env)) {
      if (typeof value === "string") env[key] = value;
    }
    env.TZ = "America/Chicago";
    env.SPOTTER_DST_PROBE = "1";
    env.FORCE_COLOR = "0";
    const result = spawnSync(vitestBin, ["run", "src/lib/departurePicker.test.ts"], {
      cwd: frontendRoot,
      env,
      encoding: "utf8",
      timeout: 75_000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-4000);
    expect(result.status, output).toBe(0);
  }, 90_000);
});

describe.skipIf(!dstProbe)("America/Chicago daylight saving", () => {
  it("keeps tomorrow 6 AM on the clock through the spring-forward night", () => {
    const now = new Date(2026, 2, 7, 22, 30);
    const morning = quickPicks(now).find((pick) => pick.id === "tomorrow-morning");
    expect(morning?.value).toBe("2026-03-08T06:00");
    expect(parseLocalInput(morning?.value ?? "")?.getHours()).toBe(6);
    expect(morning?.disabled).toBe(false);
  });

  it("disables the missing 2 AM hour and still offers 3 AM", () => {
    const now = new Date(2026, 2, 8, 0, 30);
    const slots = hourSlots("2026-03-08", 0, now);
    expect(slots.find((slot) => slot.hour === 2)).toMatchObject({ disabled: true, reason: REASON_GAP });
    expect(slots.find((slot) => slot.hour === 1)?.disabled).toBe(false);
    expect(slots.find((slot) => slot.hour === 3)?.disabled).toBe(false);
    expect(explainDisabledHours(slots)).toMatch(/2 AM does not exist when clocks spring forward/);
    expect(classifySlot("2026-03-08", 2, 0, now).value).toBeNull();
  });

  it("counts In 2 h as two real hours across the missing hour", () => {
    const now = new Date(2026, 2, 8, 0, 30);
    const picks = quickPicks(now);
    expect(picks.find((pick) => pick.id === "now")?.value).toBe("2026-03-08T01:00");
    expect(picks.find((pick) => pick.id === "plus-2h")?.value).toBe("2026-03-08T04:00");
  });

  it("keeps the repeated fall-back hour as one local clock time", () => {
    const now = new Date(2026, 10, 1, 0, 30);
    const slot = classifySlot("2026-11-01", 1, 30, now);
    expect(slot.disabled).toBe(false);
    expect(slot.value).toBe("2026-11-01T01:30");
    expect(parseLocalInput("2026-11-01T01:30")?.getMinutes()).toBe(30);
  });
});
