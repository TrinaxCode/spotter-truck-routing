export const RISK_LABELS = ["Low", "Moderate", "High", "Severe", "No Travel"] as const;

export type RiskLevel = 0 | 1 | 2 | 3 | 4;
export type RiskLabel = (typeof RISK_LABELS)[number];

export interface Assessment {
  level: RiskLevel;
  wind: RiskLevel;
  rain: RiskLevel;
  snow: RiskLevel;
  reasons: string[];
}

function asLevel(value: number): RiskLevel {
  if (value <= 0) return 0;
  if (value >= 4) return 4;
  return value as RiskLevel;
}

/** Sustained wind, mph. Lower bound inclusive, upper bound exclusive. */
export function windLevel(windMph: number): RiskLevel {
  if (windMph >= 55) return 4;
  if (windMph >= 45) return 3;
  if (windMph >= 35) return 2;
  if (windMph >= 25) return 1;
  return 0;
}

/** Rain, inches per hour. Severe includes 1.00; No Travel is strictly above 1.00. */
export function rainLevel(rainInHr: number): RiskLevel {
  if (rainInHr > 1) return 4;
  if (rainInHr >= 0.5) return 3;
  if (rainInHr >= 0.25) return 2;
  if (rainInHr >= 0.1) return 1;
  return 0;
}

/** Snow, inches per hour. Severe includes 3.0; No Travel is strictly above 3.0. */
export function snowLevel(snowInHr: number): RiskLevel {
  if (snowInHr > 3) return 4;
  if (snowInHr >= 2) return 3;
  if (snowInHr >= 1) return 2;
  if (snowInHr >= 0.5) return 1;
  return 0;
}

export function windLevelWithLoad(windMph: number, loadLbs: number): RiskLevel {
  if (windMph >= 55) return 4;
  if (windMph >= 45 && windMph < 55 && loadLbs > 30_000) return 4;
  if (windMph >= 35 && windMph < 45 && loadLbs > 40_000) return 3;
  return windLevel(windMph);
}

function formatWind(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatLoad(loadLbs: number): string {
  return Math.round(loadLbs).toLocaleString("en-US");
}

export function assess(
  windMph: number,
  rainInHr: number,
  snowInHr: number,
  loadLbs: number,
): Assessment {
  const wind = windLevelWithLoad(windMph, loadLbs);
  const rain = rainLevel(rainInHr);
  const snow = snowLevel(snowInHr);
  const level = asLevel(Math.max(wind, rain, snow));
  const reasons: string[] = [];
  const windEscalated = wind > windLevel(windMph);

  if (wind >= 1) {
    if (windEscalated) {
      reasons.push(
        `Wind ${formatWind(windMph)} mph with ${formatLoad(loadLbs)} lb load → ${RISK_LABELS[wind]}`,
      );
    } else {
      reasons.push(`Wind ${formatWind(windMph)} mph → ${RISK_LABELS[wind]}`);
    }
  }
  if (rain >= 1) {
    reasons.push(`Rain ${rainInHr.toFixed(2)} in/hr → ${RISK_LABELS[rain]}`);
  }
  if (snow >= 1) {
    reasons.push(`Snow ${snowInHr.toFixed(2)} in/hr → ${RISK_LABELS[snow]}`);
  }

  return { level, wind, rain, snow, reasons };
}
