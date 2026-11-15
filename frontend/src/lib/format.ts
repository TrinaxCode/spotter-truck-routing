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
  const date = new Date(Date.parse(startIso) + hour * 3_600_000);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return `${frameClock.format(date).replace(",", "")} (+${hour} h)`;
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
