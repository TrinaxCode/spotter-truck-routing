import { nextFullHourInput, toLocalInput } from "./time";

/** Calendar days shown in the strip, starting today. */
export const DAY_COUNT = 15;

const HOUR_MS = 3_600_000;
const WINDOW_PAST_MS = HOUR_MS;
const WINDOW_FUTURE_MS = 14 * 24 * HOUR_MS;
const QUARTER_MINUTES = [0, 15, 30, 45] as const;

export const REASON_EARLY = "Before the one-hour window.";
export const REASON_LATE = "Past the 14-day forecast.";
export const REASON_GAP = "Clocks spring forward; this hour does not exist.";

export type QuickPickId = "now" | "plus-2h" | "tonight" | "tomorrow-morning";

export interface QuickPick {
  id: QuickPickId;
  label: string;
  /** datetime-local value, `YYYY-MM-DDTHH:mm`. Empty when the clock time does not exist. */
  value: string;
  disabled: boolean;
  reason?: string;
}

export interface DayOption {
  /** `YYYY-MM-DD` in the local calendar. */
  key: string;
  weekday: string;
  day: number;
  month: number;
  year: number;
  relation: "Today" | "Tomorrow" | null;
  disabled: boolean;
  reason?: string;
}

export interface HourOption {
  hour: number;
  label: string;
  disabled: boolean;
  reason?: string;
}

export interface MinuteOption {
  minute: number;
  label: string;
  disabled: boolean;
  reason?: string;
}

export interface SlotInfo {
  disabled: boolean;
  reason?: string;
  value: string | null;
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Local clock parts. Month is 1–12. Built with the Date calendar constructor so a 23-hour or
 * 25-hour daylight-saving day still lands on the clock time we asked for, instead of UTC+24h.
 */
function dateFromParts(parts: CalendarParts): Date {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

function partsOf(date: Date): CalendarParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function sameClock(date: Date, parts: CalendarParts): boolean {
  const back = partsOf(date);
  return (
    back.year === parts.year &&
    back.month === parts.month &&
    back.day === parts.day &&
    back.hour === parts.hour &&
    back.minute === parts.minute
  );
}

export function parseLocalInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const parts: CalendarParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.hour > 23 || parts.minute > 59) return null;
  const date = dateFromParts(parts);
  if (Number.isNaN(date.getTime()) || !sameClock(date, parts)) return null;
  return date;
}

export function dateKeyFromDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDayKey(key: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Local `YYYY-MM-DDTHH:mm`, or null when that clock time is skipped (spring forward). */
export function composeLocal(dayKey: string, hour: number, minute: number): string | null {
  const day = parseDayKey(dayKey);
  if (!day) return null;
  const parts: CalendarParts = { ...day, hour, minute };
  const date = dateFromParts(parts);
  if (Number.isNaN(date.getTime()) || !sameClock(date, parts)) return null;
  return toLocalInput(date);
}

export function windowBounds(now: Date): { min: number; max: number } {
  return { min: now.getTime() - WINDOW_PAST_MS, max: now.getTime() + WINDOW_FUTURE_MS };
}

export function classifySlot(dayKey: string, hour: number, minute: number, now: Date): SlotInfo {
  const value = composeLocal(dayKey, hour, minute);
  if (!value) return { disabled: true, reason: REASON_GAP, value: null };
  const date = parseLocalInput(value);
  if (!date) return { disabled: true, reason: REASON_GAP, value: null };
  const { min, max } = windowBounds(now);
  if (date.getTime() < min) return { disabled: true, reason: REASON_EARLY, value };
  if (date.getTime() > max) return { disabled: true, reason: REASON_LATE, value };
  return { disabled: false, value };
}

function ceilQuarter(ms: number): Date {
  const date = new Date(ms);
  date.setSeconds(0, 0);
  let guard = 0;
  while ((date.getTime() < ms || date.getMinutes() % 15 !== 0) && guard < 8) {
    const mod = date.getMinutes() % 15;
    date.setMinutes(date.getMinutes() + (mod === 0 ? 15 : 15 - mod));
    guard += 1;
  }
  return date;
}

function floorQuarter(ms: number): Date {
  const date = new Date(ms);
  date.setSeconds(0, 0);
  const mod = date.getMinutes() % 15;
  if (mod !== 0) date.setMinutes(date.getMinutes() - mod);
  if (date.getTime() > ms) date.setMinutes(date.getMinutes() - 15);
  return date;
}

/**
 * Pulls a datetime-local value into the departure window, on a quarter hour when it was outside.
 * A value already inside the window keeps its minutes, including ones that are not :00/:15/:30/:45.
 */
export function clampToWindow(value: string, now: Date): string {
  const { min, max } = windowBounds(now);
  const date = parseLocalInput(value);
  if (date && date.getTime() >= min && date.getTime() <= max) return toLocalInput(date);
  let target = !date || date.getTime() < min ? ceilQuarter(min) : floorQuarter(max);
  if (target.getTime() > max) target = floorQuarter(max);
  if (target.getTime() < min) target = ceilQuarter(min);
  return toLocalInput(target);
}

export function formatHourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 || 12;
  return `${hour12} ${suffix}`;
}

export function formatClockLabel(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** Quarter hours, plus the current minute when a suggested departure is not on a quarter. */
export function minuteChoices(minute: number): number[] {
  const choices: number[] = [...QUARTER_MINUTES];
  if (!choices.includes(minute) && minute >= 0 && minute <= 59) choices.push(minute);
  choices.sort((a, b) => a - b);
  return choices;
}

function atClock(now: Date, dayOffset: number, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);
}

function packPick(id: QuickPickId, label: string, date: Date, now: Date): QuickPick {
  const parts = partsOf(date);
  const value = sameClock(date, parts) ? toLocalInput(date) : "";
  if (!value) return { id, label, value: "", disabled: true, reason: REASON_GAP };
  const slot = classifySlot(dateKeyFromDate(date), parts.hour, parts.minute, now);
  return { id, label, value: slot.value ?? value, disabled: slot.disabled, reason: slot.reason };
}

export function quickPicks(now: Date): QuickPick[] {
  const anchor = parseLocalInput(nextFullHourInput(now)) ?? new Date(nextFullHourInput(now));
  const inTwoHours = new Date(anchor.getTime() + 2 * HOUR_MS);
  const tonightAt = atClock(now, 0, 20, 0);
  const tonightPast = tonightAt.getTime() < now.getTime();
  const tonight = tonightPast ? atClock(now, 1, 20, 0) : tonightAt;
  const morning = atClock(now, 1, 6, 0);
  return [
    packPick("now", "Now", anchor, now),
    packPick("plus-2h", "In 2 h", inTwoHours, now),
    packPick("tonight", tonightPast ? "Tomorrow 8 PM" : "Tonight 8 PM", tonight, now),
    packPick("tomorrow-morning", "Tomorrow 6 AM", morning, now),
  ];
}

export function selectionParts(value: string, now: Date): { dayKey: string; hour: number; minute: number } {
  const date = parseLocalInput(value) ?? parseLocalInput(nextFullHourInput(now)) ?? now;
  return { dayKey: dateKeyFromDate(date), hour: date.getHours(), minute: date.getMinutes() };
}

const weekdayShort = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const weekdayLong = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const monthShort = new Intl.DateTimeFormat("en-US", { month: "short" });
const monthLong = new Intl.DateTimeFormat("en-US", { month: "long" });

export function dayAccessibleName(day: DayOption): string {
  const noon = new Date(day.year, day.month - 1, day.day, 12, 0, 0, 0);
  const prefix = day.relation ? `${day.relation}, ` : "";
  return `${prefix}${weekdayLong.format(noon)}, ${monthLong.format(noon)} ${day.day}`;
}

export function dayStrip(now: Date): DayOption[] {
  const days: DayOption[] = [];
  for (let offset = 0; offset < DAY_COUNT; offset += 1) {
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12, 0, 0, 0);
    const key = dateKeyFromDate(noon);
    const slots = hourSlots(key, 0, now);
    const disabled = slots.every((slot) => slot.disabled);
    days.push({
      key,
      weekday: weekdayShort.format(noon),
      day: noon.getDate(),
      month: noon.getMonth() + 1,
      year: noon.getFullYear(),
      relation: offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : null,
      disabled,
      reason: disabled ? slots.find((slot) => slot.reason)?.reason : undefined,
    });
  }
  return days;
}

export function hourSlots(dayKey: string, minute: number, now: Date): HourOption[] {
  const minutes = minuteChoices(minute);
  return Array.from({ length: 24 }, (_, hour) => {
    const slots = minutes.map((choice) => classifySlot(dayKey, hour, choice, now));
    const disabled = slots.every((slot) => slot.disabled);
    return {
      hour,
      label: formatHourLabel(hour),
      disabled,
      reason: disabled ? sharedReason(slots) : undefined,
    };
  });
}

export function minuteSlots(dayKey: string, hour: number, minute: number, now: Date): MinuteOption[] {
  return minuteChoices(minute).map((choice) => {
    const slot = classifySlot(dayKey, hour, choice, now);
    return {
      minute: choice,
      label: `:${String(choice).padStart(2, "0")}`,
      disabled: slot.disabled,
      reason: slot.reason,
    };
  });
}

function sharedReason(slots: SlotInfo[]): string | undefined {
  const reasons = slots.map((slot) => slot.reason).filter((reason): reason is string => Boolean(reason));
  if (reasons.length === 0) return undefined;
  if (reasons.every((reason) => reason === reasons[0])) return reasons[0];
  return reasons[0];
}

function groupHours(hours: number[]): number[][] {
  const ranges: number[][] = [];
  for (const hour of hours) {
    const last = ranges[ranges.length - 1];
    if (last && last[last.length - 1] === hour - 1) last.push(hour);
    else ranges.push([hour]);
  }
  return ranges;
}

function joinRanges(ranges: number[][]): string {
  const parts = ranges.map((range) => {
    const start = range[0] ?? 0;
    const end = range[range.length - 1] ?? start;
    if (range.length === 1) return formatHourLabel(start);
    return `${formatHourLabel(start)}\u2013${formatHourLabel(end)}`;
  });
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** One sentence per reason, naming the disabled hours. Null when every hour can be chosen. */
export function explainDisabledHours(slots: HourOption[]): string | null {
  const sentences: string[] = [];
  const kinds: { reason: string; singular: string; plural: string }[] = [
    { reason: REASON_EARLY, singular: "is before the one-hour window", plural: "are before the one-hour window" },
    { reason: REASON_LATE, singular: "is past the 14-day forecast", plural: "are past the 14-day forecast" },
    {
      reason: REASON_GAP,
      singular: "does not exist when clocks spring forward",
      plural: "do not exist when clocks spring forward",
    },
  ];
  for (const kind of kinds) {
    const hours = slots.filter((slot) => slot.disabled && slot.reason === kind.reason).map((slot) => slot.hour);
    if (hours.length === 0) continue;
    const subject = joinRanges(groupHours(hours));
    sentences.push(`${subject} ${hours.length === 1 ? kind.singular : kind.plural}.`);
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/**
 * Keeps the clock time when that slot is inside the window. Otherwise the nearest open slot on
 * the same day: same hour first, then the closer hour, preferring the earlier one on a tie.
 */
export function resolveSelection(dayKey: string, hour: number, minute: number, now: Date): string | null {
  const preferred = classifySlot(dayKey, hour, minute, now);
  if (!preferred.disabled && preferred.value) return preferred.value;
  const minutes = minuteChoices(minute);
  for (const choice of minutes) {
    const slot = classifySlot(dayKey, hour, choice, now);
    if (!slot.disabled && slot.value) return slot.value;
  }
  for (let distance = 1; distance < 24; distance += 1) {
    for (const candidate of [hour - distance, hour + distance]) {
      if (candidate < 0 || candidate > 23) continue;
      const sameMinute = classifySlot(dayKey, candidate, minute, now);
      if (!sameMinute.disabled && sameMinute.value) return sameMinute.value;
      for (const choice of minutes) {
        const slot = classifySlot(dayKey, candidate, choice, now);
        if (!slot.disabled && slot.value) return slot.value;
      }
    }
  }
  return null;
}

function relativeLabel(deltaMs: number): string {
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes === 0) return "now";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const body = hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return minutes > 0 ? `in ${body}` : `${body} ago`;
}

function zoneAbbrev(date: Date): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

/** "Leaves Tue, Nov 18 · 6:00 AM CST · in 9 h". */
export function summaryLine(value: string, now: Date): string {
  const date = parseLocalInput(value);
  if (!date) return "Choose a departure time.";
  const zone = zoneAbbrev(date);
  const zoneSuffix = zone ? ` ${zone}` : "";
  return `Leaves ${weekdayShort.format(date)}, ${monthShort.format(date)} ${date.getDate()} · ${formatClockLabel(date.getHours(), date.getMinutes())}${zoneSuffix} · ${relativeLabel(date.getTime() - now.getTime())}`;
}

/** Compact label for the closed control: "Tue, Nov 18 · 6:00 AM". */
export function triggerLabel(value: string): string {
  const date = parseLocalInput(value);
  if (!date) return "Choose a departure";
  return `${weekdayShort.format(date)}, ${monthShort.format(date)} ${date.getDate()} · ${formatClockLabel(date.getHours(), date.getMinutes())}`;
}

/** Next index in `enabled` after `step` hops, wrapping. Stays put when nothing is enabled. */
export function nextEnabledIndex(current: number, step: number, enabled: readonly boolean[]): number {
  const count = enabled.length;
  if (count === 0 || step === 0 || !enabled.some(Boolean)) return current;
  for (let hop = 1; hop <= count; hop += 1) {
    const index = (((current + step * hop) % count) + count) % count;
    if (enabled[index]) return index;
  }
  return current;
}
