import logging
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
VARIABLES = ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall",
             "temperature_2m", "weather_code")


@dataclass(frozen=True)
class Weather:
    wind_mph: float
    gust_mph: float
    rain_in_hr: float
    snow_in_hr: float
    temp_f: float
    weather_code: int
    forecast_time: str


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
    for start in range(0, len(missing), 100):
        batch = missing[start:start + 100]
        params = {
            "latitude": ",".join(f"{c[1]:g}" for c in batch),
            "longitude": ",".join(f"{c[0]:g}" for c in batch),
            "hourly": ",".join(VARIABLES), "wind_speed_unit": "mph",
            "precipitation_unit": "inch", "temperature_unit": "fahrenheit",
            "timezone": "GMT", "timeformat": "unixtime", "forecast_days": 16, "past_days": 1,
        }
        if commercial:
            params["apikey"] = settings.OPEN_METEO_API_KEY
        try:
            payload = get_json(url, params)
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
        if (any(v < 0 for v in (wind, gust, rain, showers, snow, code))
                or not isfinite(rain + showers)):
            return None
        return Weather(wind, gust, rain + showers, snow, temp, int(code),
                       utc_iso(datetime.fromtimestamp(precipitation_hour, UTC)))
    except (ValueError, IndexError):
        return None
