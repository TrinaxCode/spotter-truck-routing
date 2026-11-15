"""Compare later departures on fixed routes; traffic is not requested again."""

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta

from django.core.cache import cache
from django.utils import timezone
from rest_framework.exceptions import NotFound

from .http import utc_iso
from .planner import PLAN_TTL_S
from .recommend import RouteScore, rank_routes, ranking_key, score_route
from .risk import assess
from .sampling import owned_miles
from .weather import fetch_forecasts, rounded_coord, select_weather


def suggest_departure(
    best_by_offset: Sequence[RouteScore], base_departure: datetime, labels: Mapping[str, str],
) -> dict | None:
    # Stable min picks the earliest offset on risk ties, irrespective of total trip time.
    offset = min(range(len(best_by_offset)), key=lambda i: ranking_key(best_by_offset[i])[:-1])
    baseline, best = best_by_offset[0], best_by_offset[offset]
    base_key, best_key = ranking_key(baseline)[:-1], ranking_key(best)[:-1]
    if best_key >= base_key:
        return None
    keys = ("no_travel", "severe", "high")
    improvement = {f"{key}_mi": round(a - b, 1)
                   for key, a, b in zip(keys, base_key[1:4], best_key[1:4], strict=True)}
    reason = "for complete weather coverage."
    for key, label in zip(keys, ("No Travel", "Severe", "High"), strict=True):
        miles = improvement[f"{key}_mi"]
        if miles > 0:
            reason = f"to avoid {miles:g} mi of {label} weather."
            break
    else:
        if best_key[4] < base_key[4]:
            reason = f"to lower average risk from {base_key[4]:.2f} to {best_key[4]:.2f}."
    return {
        "offset_h": offset,
        "departure": utc_iso(base_departure + timedelta(hours=offset)),
        "route_id": best.route_id,
        "headline": f"Leave {offset} h later on {labels[best.route_id]} {reason}",
        "improvement": improvement,
    }


def get_departure_options(plan_id: str) -> dict:
    plan = cache.get(f"plan:{plan_id}")
    if plan is None:
        raise NotFound("Plan is unknown or expired. Please create a new plan.")
    existing = cache.get(f"departures:{plan_id}")
    if existing is not None:
        return existing
    base = plan.get("_departure") or datetime.fromisoformat(plan["request"]["departure"])
    coords = list(dict.fromkeys(rounded_coord((p["lon"], p["lat"]))
                               for route in plan["routes"] for p in route["checkpoints"]))
    forecasts = fetch_forecasts(coords)
    prepared = []
    for route in plan["routes"]:
        points = route["checkpoints"]
        offsets = plan.get("_eta_offsets_s", {}).get(route["id"])
        if offsets is None:
            # Plans cached before this extension still have usable, whole-second ETAs.
            offsets = [(datetime.fromisoformat(p["eta"]) - base).total_seconds() for p in points]
        prepared.append((
            route, owned_miles([p["mile"] for p in points], route["distance_mi"]),
            [timedelta(seconds=seconds) for seconds in offsets],
            [forecasts[rounded_coord((p["lon"], p["lat"]))] for p in points],
        ))
    options, best_by_offset = [], []
    for offset in range(25):
        departure = base + timedelta(hours=offset)
        summaries, scores = [], []
        for route, owned, eta_offsets, route_forecasts in prepared:
            levels = []
            for delta, forecast in zip(eta_offsets, route_forecasts, strict=True):
                weather = select_weather(forecast, departure + delta)
                levels.append(assess(weather.wind_mph, weather.rain_in_hr, weather.snow_in_hr,
                                     plan["request"]["load_lbs"]).level if weather else None)
            score = score_route(route["id"], owned, levels, route["total_time_s"])
            scores.append(score)
            known = [level for level in levels if level is not None]
            summaries.append({
                "route_id": score.route_id, "miles_by_level": dict(score.miles_by_level),
                "avg_risk": score.avg_risk, "max_level": int(max(known)) if known else None,
                "weather_coverage": 1 - score.miles_by_level["unknown"] / route["distance_mi"],
                "total_time_s": score.total_time_s,
                "arrival": utc_iso(departure + timedelta(seconds=score.total_time_s)),
            })
        best = rank_routes(scores)[0]
        best_by_offset.append(best)
        options.append({"offset_h": offset, "departure": utc_iso(departure),
                        "best_route_id": best.route_id, "routes": summaries})
    result = {"plan_id": plan_id, "base_departure": utc_iso(base), "options": options,
              "suggestion": suggest_departure(best_by_offset, base,
                                              {r["id"]: r["label"] for r in plan["routes"]})}
    expiry = plan.get("_expires_at")
    if expiry is None:
        expiry = datetime.fromisoformat(plan["generated_at"]).timestamp() + PLAN_TTL_S
    cache.set(f"departures:{plan_id}", result, max(0, expiry - timezone.now().timestamp()))
    return result
