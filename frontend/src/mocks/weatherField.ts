/**
 * Synthetic corridor weather for the Dallas → Denver demo fixtures.
 * Hour 0 is the departure hour. A snow/wind cell starts over Amarillo and
 * drifts toward Raton so the panhandle and southern routes meet it, while
 * the I-70 route stays north of the cell. A dry cold front crosses Kansas early on,
 * so the I-70 route has a cleaner window a few hours after departure.
 */

export interface FieldSample {
  windMph: number;
  gustMph: number;
  rainInHr: number;
  snowInHr: number;
  tempF: number;
  weatherCode: number;
}

function stormCenter(hour: number): { lat: number; lon: number } {
  const t = Math.min(Math.max(hour, 0), 40) / 40;
  return {
    lat: 35.22 + (36.95 - 35.22) * t,
    lon: -101.83 + (-104.45 - -101.83) * t,
  };
}

/**
 * A dry cold front sweeping east across the plains (north of the panhandle): gusty, no
 * precipitation. Routes crossing Kansas while it passes see High wind; leaving later clears it.
 */
function frontWind(lat: number, lon: number, hour: number): number {
  if (lat < 35.4 || lat > 40.2) return 0;
  const centre = -101.4 + 0.45 * hour;
  const distance = Math.abs(lon - centre);
  if (distance > 1.3) return 0;
  return 41 - distance * 6;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function sampleField(lat: number, lon: number, hour: number): FieldSample {
  const center = stormCenter(hour);
  const dLat = lat - center.lat;
  const dLon = (lon - center.lon) * Math.cos((center.lat * Math.PI) / 180);
  const distance = Math.hypot(dLat, dLon);
  const mature = hour >= 3 && hour <= 36 ? 1 : hour < 3 ? 0.75 : 0.55;

  let wind = 12;
  let rain = 0;
  let snow = 0;
  let temp = 58 - (lat - 32) * 2.4;

  if (distance < 0.55) {
    wind = 58 * mature + 20 * (1 - mature);
    snow = 3.6 * mature;
    rain = 0.02;
    temp = 16;
  } else if (distance < 1.05) {
    // Snow is Severe while sustained wind stays under the load-escalation line.
    wind = 22;
    snow = 2.4 * mature;
    rain = 0.04;
    temp = 23;
  } else if (distance < 1.75) {
    wind = 36 * mature + 16 * (1 - mature);
    snow = 0.1 * mature;
    rain = 0.32 * mature;
    temp = 36;
  } else if (lat > 38.15 && lat < 40.3 && lon > -103.2 && lon < -97.4) {
    wind = 27;
    rain = hour >= 18 && hour <= 30 ? 0.14 : 0;
    temp = 46;
  } else {
    wind = 14 + Math.max(0, -100 - lon) * 0.35;
    wind = Math.min(wind, 22);
    rain = 0;
  }

  if (distance >= 1.05) wind = Math.max(wind, frontWind(lat, lon, hour));

  wind = round2(wind);
  const gust = round2(wind * 1.42);
  rain = round2(rain);
  snow = round2(snow);
  temp = round2(temp);
  const weatherCode = snow >= 0.5 ? 73 : rain >= 0.1 ? 63 : wind >= 25 ? 3 : 1;
  return { windMph: wind, gustMph: gust, rainInHr: rain, snowInHr: snow, tempF: temp, weatherCode };
}
