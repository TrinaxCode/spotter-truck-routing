const DRIVE_BEFORE_BREAK_S = 8 * 3600;
const DRIVE_BEFORE_REST_S = 11 * 3600;
const BREAK_30_S = 30 * 60;
const REST_10_S = 10 * 3600;

export interface DutyBreak {
  type: "break_30m" | "off_duty_10h";
  /** Drive seconds completed when the break starts. */
  atDriveS: number;
  durationS: number;
  /** Elapsed seconds from departure to the start of the break, including earlier breaks. */
  elapsedAtStartS: number;
}

/**
 * FMCSA property-carrying, simplified.
 * 30 min break after 8 h of driving since the last break or rest.
 * 10 h off duty after 11 h of driving. The 14 h window is not modelled.
 * A break is inserted only when driving continues after the limit.
 */
export function elapsedWithBreaks(driveSeconds: number, enabled = true): number {
  if (!enabled) return Math.max(0, Math.round(driveSeconds));
  return walk(Math.round(driveSeconds)).elapsed;
}

export function breakSchedule(driveSeconds: number): DutyBreak[] {
  return walk(Math.max(0, Math.round(driveSeconds))).breaks;
}

function walk(totalDrive: number): { elapsed: number; breaks: DutyBreak[] } {
  if (totalDrive <= 0) return { elapsed: 0, breaks: [] };

  let remaining = totalDrive;
  let elapsed = 0;
  let sinceBreak = 0;
  let sinceRest = 0;
  const breaks: DutyBreak[] = [];

  while (remaining > 0) {
    const chunk = Math.min(remaining, DRIVE_BEFORE_BREAK_S - sinceBreak, DRIVE_BEFORE_REST_S - sinceRest);
    if (chunk <= 0) {
      const before = breaks.length;
      insertBreak();
      if (breaks.length === before) break;
      continue;
    }

    elapsed += chunk;
    remaining -= chunk;
    sinceBreak += chunk;
    sinceRest += chunk;
    if (remaining === 0) break;
    insertBreak();
  }

  return { elapsed, breaks };

  function insertBreak(): void {
    if (sinceRest >= DRIVE_BEFORE_REST_S) {
      breaks.push({
        type: "off_duty_10h",
        atDriveS: totalDrive - remaining,
        durationS: REST_10_S,
        elapsedAtStartS: elapsed,
      });
      elapsed += REST_10_S;
      sinceBreak = 0;
      sinceRest = 0;
      return;
    }
    if (sinceBreak >= DRIVE_BEFORE_BREAK_S) {
      breaks.push({
        type: "break_30m",
        atDriveS: totalDrive - remaining,
        durationS: BREAK_30_S,
        elapsedAtStartS: elapsed,
      });
      elapsed += BREAK_30_S;
      sinceBreak = 0;
    }
  }
}
