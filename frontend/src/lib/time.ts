export function nextFullHourInput(now = new Date()): string {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return toLocalInput(date);
}

export function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local value → ISO-8601 with the local UTC offset, e.g. 2026-11-16T08:00:00-06:00. */
export function localInputToOffsetIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid departure");
  }
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  const [day, time] = value.split("T");
  const clock = time.length === 5 ? `${time}:00` : time;
  return `${day}T${clock}${sign}${hours}:${minutes}`;
}

export function departureError(value: string, now = new Date()): string | undefined {
  if (!value) return "Choose a departure time.";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Departure time is not valid.";
  const min = now.getTime() - 3_600_000;
  const max = now.getTime() + 14 * 24 * 3_600_000;
  if (date.getTime() < min) return "Departure must be no earlier than one hour ago.";
  if (date.getTime() > max) return "Departure must be within the next 14 days.";
  return undefined;
}

export function toUtcZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function floorHourIso(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return toUtcZ(Math.floor(ms / 3_600_000) * 3_600_000);
}

/**
 * Heatmap frame whose data a checkpoint's weather is closest to. The backend reads wind from the
 * nearest hour (ties later) and rain/snow from the hour that closes the ETA, so rounding, not
 * flooring, picks the frame that agrees with the checkpoint. -1 when outside the frames.
 */
export function etaHourIndex(startIso: string, etaIso: string, hours = 49): number {
  const start = Date.parse(startIso);
  const eta = Date.parse(etaIso);
  if (Number.isNaN(start) || Number.isNaN(eta)) return -1;
  const index = Math.round((eta - start) / 3_600_000);
  if (index < 0 || index >= hours) return -1;
  return index;
}
