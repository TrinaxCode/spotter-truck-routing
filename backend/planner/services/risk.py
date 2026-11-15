from dataclasses import dataclass
from enum import IntEnum
from math import isfinite


class RiskLevel(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4


LABELS = ("Low", "Moderate", "High", "Severe", "No Travel")
LEVEL_KEYS = ("low", "moderate", "high", "severe", "no_travel")


def nonnegative(value: float) -> float:
    if not isfinite(value) or value < 0:
        raise ValueError("Expected a finite nonnegative value.")
    return value


def wind_level(wind_mph: float) -> RiskLevel:
    value = nonnegative(wind_mph)
    return RiskLevel(sum(value >= boundary for boundary in (25, 35, 45, 55)))


def rain_level(rain_in_hr: float) -> RiskLevel:
    value = nonnegative(rain_in_hr)
    return RiskLevel(sum(value >= b for b in (.10, .25, .50)) + (value > 1))


def snow_level(snow_in_hr: float) -> RiskLevel:
    value = nonnegative(snow_in_hr)
    return RiskLevel(sum(value >= b for b in (.5, 1, 2)) + (value > 3))


def wind_level_with_load(wind_mph: float, load_lbs: float) -> RiskLevel:
    base = wind_level(wind_mph)
    nonnegative(load_lbs)
    if wind_mph >= 55 or (45 <= wind_mph < 55 and load_lbs > 30000):
        return RiskLevel.NO_TRAVEL
    if 35 <= wind_mph < 45 and load_lbs > 40000:
        return RiskLevel.SEVERE
    return base


@dataclass(frozen=True)
class Assessment:
    level: RiskLevel
    wind: RiskLevel
    rain: RiskLevel
    snow: RiskLevel
    reasons: tuple[str, ...]


def assess(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lbs: float) -> Assessment:
    wind = wind_level_with_load(wind_mph, load_lbs)
    rain = rain_level(rain_in_hr)
    snow = snow_level(snow_in_hr)
    reasons = []
    if wind:
        load = f" with {load_lbs:,.0f} lb load" if wind > wind_level(wind_mph) else ""
        reasons.append(f"Wind {wind_mph:g} mph{load} → {LABELS[wind]}")
    if rain:
        reasons.append(f"Rain {rain_in_hr:g} in/hr → {LABELS[rain]}")
    if snow:
        reasons.append(f"Snow {snow_in_hr:g} in/hr → {LABELS[snow]}")
    return Assessment(max(wind, rain, snow), wind, rain, snow, tuple(reasons))
