const milesFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const clockFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatMiles(miles: number): string {
  return `${milesFormat.format(miles)} mi`;
}

export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const total = Math.abs(Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${sign}${minutes} min`;
  return `${sign}${hours} hr ${String(minutes).padStart(2, "0")} min`;
}

export function formatLoadLbs(pounds: number): string {
  return `${Math.round(pounds).toLocaleString("en-US")} lb`;
}

/** Accepts digits and thousands separators. Rejects decimals and signs. */
export function parseLoadLbs(input: string): number | null {
  const cleaned = input.replace(/,/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export function formatTempF(value: number): string {
  return `${numberFormat.format(value)}°F`;
}

export function formatSpeedMph(value: number): string {
  return `${numberFormat.format(value)} mph`;
}

export function formatInchesPerHour(value: number): string {
  return `${value.toFixed(2)} in/hr`;
}

export function formatAvgRisk(value: number): string {
  return value.toFixed(2);
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return clockFormat.format(date);
}

const frameClock = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const tripWhen = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** "Sun 3:00 PM (+5 h)" in the viewer's local zone. */
export function formatFrameLabel(startIso: string, hour: number): string {
  return `${formatFrameTime(startIso, hour)} (+${hour} h)`;
}

/** "Sun 3:00 PM" in the viewer's local zone. */
export function formatFrameTime(startIso: string, hour: number): string {
  const date = new Date(Date.parse(startIso) + hour * 3_600_000);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return frameClock.format(date).replace(",", "");
}

/** "20 min", "2 h" or "1 h 40 min" for a whole number of minutes (> 0). */
function spanLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Where a forecast frame sits relative to the real departure. Frames are whole hours from the
 * departure hour (floored), so with a 5:20 departure frame 0 is 5:00: "20 min before departure",
 * frame 1 is "+40 min from departure". With an on-the-hour departure this reads "At departure",
 * "+1 h from departure", ... Without the start and departure times it falls back to the plain
 * frame number.
 */
export function formatFrameOffset(hour: number, startIso?: string | null, departureIso?: string | null): string {
  const start = startIso ? Date.parse(startIso) : Number.NaN;
  const departure = departureIso ? Date.parse(departureIso) : Number.NaN;
  const minutes =
    Number.isNaN(start) || Number.isNaN(departure)
      ? hour * 60
      : Math.round((start + hour * 3_600_000 - departure) / 60_000);
  if (minutes === 0) return "At departure";
  if (minutes < 0) return `${spanLabel(-minutes)} before departure`;
  return `+${spanLabel(minutes)} from departure`;
}

const shortClock = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** "Tue 12:30 PM" for arrivals and ETAs. */
export function formatShortClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return shortClock.format(date).replace(",", "");
}

/** "Mon 3:40a" or "Mon 6p": weekday and a one-letter meridiem, for tight chart axes. */
export function formatCompactClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return `${weekday.format(date)} ${shortHour(date)}`;
}

export interface ForecastTick {
  hour: number;
  /** Compact local clock, e.g. "3p" or "3:30p". */
  time: string;
  /** Weekday when this tick starts a new local day, including hour 0. */
  day: string | null;
}

function shortHour(date: Date): string {
  const hour = date.getHours();
  const minute = date.getMinutes();
  const h12 = hour % 12 || 12;
  const suffix = hour < 12 ? "a" : "p";
  if (minute === 0) return `${h12}${suffix}`;
  return `${h12}:${String(minute).padStart(2, "0")}${suffix}`;
}

/** Local clock ticks. Day changes carry the weekday so midnight is marked. */
export function forecastTicks(startIso: string, span = 48, step = 6): ForecastTick[] {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return [];
  const ticks: ForecastTick[] = [];
  let previousDay = "";
  for (let hour = 0; hour <= span; hour += step) {
    const date = new Date(start + hour * 3_600_000);
    const key = date.toDateString();
    const markDay = hour === 0 || key !== previousDay;
    previousDay = key;
    ticks.push({ hour, time: shortHour(date), day: markDay ? weekday.format(date) : null });
  }
  return ticks;
}

export function shortPlace(label: string): string {
  const head = label.split(",")[0]?.trim();
  return head || label;
}

/** "Nov 16 8:00 AM" from a datetime-local value. */
export function formatTripWhen(localValue: string): string {
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return tripWhen.format(date).replace(",", "");
}

export function formatTripSummary(input: {
  origin: string;
  destination: string;
  departureLocal: string;
  loadLbs: number;
  intervalMi: number;
}): string {
  return `${shortPlace(input.origin)} → ${shortPlace(input.destination)} · ${formatTripWhen(input.departureLocal)} · ${formatLoadLbs(input.loadLbs)} · ${input.intervalMi} mi`;
}

export function formatHosBreaks(count: number): string {
  if (count === 1) return "1 HOS break";
  return `${count} HOS breaks`;
}
