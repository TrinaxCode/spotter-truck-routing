import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import ceil, floor, isfinite

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from planner.exceptions import UpstreamError

from .http import cache_key, get_json, utc_iso
from .sampling import Coord

logger = logging.getLogger(__name__)
# From cloud hosts Open-Meteo stalls on ~2 MB responses (100 places x 17 days); 25 per call
# keeps each response near 0.5 MB and fast, and the batches run in parallel.
BATCH_SIZE = 25
MAX_PARALLEL = 4
WEATHER_TIMEOUT_S = 25
VARIABLES = ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall",
             "temperature_2m", "weather_code")
# Requested too, but optional: direction only drives the map animation, never a risk rule.
DIRECTION = "wind_direction_10m"
REQUESTED = (*VARIABLES, DIRECTION)


@dataclass(frozen=True)
class Weather:
    wind_mph: float
    gust_mph: float
    rain_in_hr: float
    snow_in_hr: float
    temp_f: float
    weather_code: int
    forecast_time: str
    # Meteorological convention: the direction the wind blows FROM, degrees clockwise from north.
    # None when the provider sent no direction; it never affects risk.
    wind_dir_deg: float | None = None


def rounded_coord(coord: Coord) -> Coord:
    return round(coord[0], 1), round(coord[1], 1)


def parse_forecast(payload: dict) -> dict:
    hourly = payload["hourly"]
    times = hourly["time"]
    if not times or any(not isinstance(t, (float, int)) or not isfinite(t) for t in times):
        raise ValueError("Invalid times")
    if any(b - a != 3600 for a, b in zip(times, times[1:], strict=False)):
        raise ValueError("Non-hourly data")
    if any(not isinstance(hourly[v], list) or len(hourly[v]) != len(times) for v in VARIABLES):
        raise ValueError("Mismatched arrays")
    direction = hourly.get(DIRECTION)
    if not isinstance(direction, list) or len(direction) != len(times):
        hourly = {**hourly, DIRECTION: [None] * len(times)}
    return {"hourly": hourly}


def fetch_forecasts(coords: list[Coord]) -> dict[Coord, dict | None]:
    unique = list(dict.fromkeys(rounded_coord(c) for c in coords))
    today = timezone.now().astimezone(UTC).date()
    window = (str(today - timedelta(days=1)), str(today + timedelta(days=15)))
    keys = {c: cache_key("weather", c, window, bool(settings.OPEN_METEO_API_KEY)) for c in unique}
    cached = cache.get_many(list(keys.values()))
    result = {c: cached.get(keys[c]) for c in unique}
    missing = [c for c in unique if keys[c] not in cached]
    commercial = bool(settings.OPEN_METEO_API_KEY)
    url = ("https://customer-api.open-meteo.com/v1/forecast" if commercial
           else "https://api.open-meteo.com/v1/forecast")
    def fetch_batch(batch: list[Coord]) -> None:
        params = {
            "latitude": ",".join(f"{c[1]:g}" for c in batch),
            "longitude": ",".join(f"{c[0]:g}" for c in batch),
            "hourly": ",".join(REQUESTED), "wind_speed_unit": "mph",
            "precipitation_unit": "inch", "temperature_unit": "fahrenheit",
            "timezone": "GMT", "timeformat": "unixtime", "forecast_days": 16, "past_days": 1,
        }
        if commercial:
            params["apikey"] = settings.OPEN_METEO_API_KEY
        try:
            payload = get_json(url, params, timeout=WEATHER_TIMEOUT_S)
            items = payload if isinstance(payload, list) else [payload]
            if len(items) != len(batch):
                raise ValueError("Mismatched locations")
            for coord, item in zip(batch, items, strict=True):
                try:
                    forecast = parse_forecast(item)
                except (KeyError, TypeError, ValueError):
                    continue
                result[coord] = forecast
                cache.set(keys[coord], forecast, 30 * 60)
        except (UpstreamError, TypeError, ValueError):
            logger.warning("Weather batch unavailable; affected checkpoints remain unknown.")

    batches = [missing[start:start + BATCH_SIZE] for start in range(0, len(missing), BATCH_SIZE)]
    # Batches are independent: fetch them together so a slow one does not add up serially.
    with ThreadPoolExecutor(max_workers=max(1, min(MAX_PARALLEL, len(batches)))) as pool:
        list(pool.map(fetch_batch, batches))
    return result


def select_weather(forecast: dict | None, eta: datetime) -> Weather | None:
    if not forecast:
        return None
    hourly = forecast["hourly"]
    times = hourly["time"]
    timestamp = eta.timestamp()
    if timestamp < times[0] or timestamp > times[-1]:
        return None
    precipitation_hour = ceil(timestamp / 3600) * 3600
    instantaneous_hour = floor(timestamp / 3600 + .5) * 3600
    try:
        p, w = times.index(precipitation_hour), times.index(instantaneous_hour)
        values = [hourly[v][p if v in {"rain", "showers", "snowfall"}
                            else w] for v in VARIABLES]
        if any(v is None or not isinstance(v, (int, float)) or not isfinite(v) for v in values):
            return None
        wind, gust, rain, showers, snow, temp, code = values
        raw_direction = hourly[DIRECTION][w] if DIRECTION in hourly else None
        direction = (raw_direction % 360 if isinstance(raw_direction, (int, float))
                     and isfinite(raw_direction) else None)
        if (any(v < 0 for v in (wind, gust, rain, showers, snow, code))
                or not isfinite(rain + showers)):
            return None
        return Weather(wind, gust, rain + showers, snow, temp, int(code),
                       utc_iso(datetime.fromtimestamp(precipitation_hour, UTC)), direction)
    except (ValueError, IndexError):
        return None
