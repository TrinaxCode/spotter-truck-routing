from dataclasses import asdict
from datetime import timedelta
from uuid import uuid4

from django.core.cache import cache
from django.utils import timezone

from .hos import break_schedule, elapsed_with_breaks
from .http import utc_iso
from .recommend import RouteScore, explain, rank_routes, score_route
from .risk import LABELS, assess
from .routing import Route, get_routes
from .sampling import owned_miles, sample_checkpoints, simplify
from .weather import fetch_forecasts, rounded_coord, select_weather


def serialize_breaks(route: Route, departure, enabled: bool) -> list[dict]:
    breaks = []
    elapsed_rest = 0
    for pause in break_schedule(route.drive_time_s) if enabled else []:
        start = departure + timedelta(seconds=pause.drive_seconds_at + elapsed_rest)
        breaks.append({"type": pause.type, "at_mile": route.mile_at_drive(pause.drive_seconds_at),
                       "start": utc_iso(start), "end": utc_iso(start + timedelta(
                           seconds=pause.duration_s))})
        elapsed_rest += pause.duration_s
    return breaks


def create_plan(data: dict) -> dict:
    departure, hos, load = data["departure"], data["hos"], data["load_lbs"]
    origin = (data["origin"]["lon"], data["origin"]["lat"])
    destination = (data["destination"]["lon"], data["destination"]["lat"])
    routes, warnings = get_routes(origin, destination, departure, load)
    warnings = list(warnings)
    checkpoints = [sample_checkpoints(route.coords, data["interval_mi"], route.distance_mi)
                   for route in routes]
    forecasts = fetch_forecasts([(p.lon, p.lat) for points in checkpoints for p in points])
    serialized, scores = [], []
    for index, (route, points) in enumerate(zip(routes, checkpoints, strict=True)):
        route_id = f"r{index + 1}"
        total_time = elapsed_with_breaks(route.drive_time_s, hos)
        evaluated, levels = [], []
        for point in points:
            eta = departure + timedelta(seconds=elapsed_with_breaks(
                route.drive_seconds_at(point.mile), hos))
            weather = select_weather(forecasts[rounded_coord((point.lon, point.lat))], eta)
            assessment = (assess(weather.wind_mph, weather.rain_in_hr, weather.snow_in_hr, load)
                          if weather is not None else None)
            level = assessment.level if assessment is not None else None
            levels.append(level)
            evaluated.append({
                "index": point.index, "mile": point.mile, "lat": point.lat, "lon": point.lon,
                "eta": utc_iso(eta), "weather": asdict(weather) if weather is not None else None,
                "levels": ({"wind": int(assessment.wind), "rain": int(assessment.rain),
                            "snow": int(assessment.snow)} if assessment is not None else None),
                "level": int(level) if level is not None else None,
                "level_label": LABELS[level] if level is not None else "Unknown",
                "reasons": list(assessment.reasons) if assessment is not None else [
                    "Weather is unavailable at this checkpoint's ETA."],
            })
        score = score_route(route_id, owned_miles([p.mile for p in points], route.distance_mi),
                            levels, total_time)
        scores.append(score)
        coverage = 1 - score.miles_by_level["unknown"] / route.distance_mi
        if coverage < 1:
            warnings.append(f"Route {chr(65 + index)} has incomplete weather coverage "
                            f"({coverage:.0%}); unknown miles are not Low risk. "
                            "Routes with full coverage take priority in the recommendation.")
        known = [level for level in levels if level is not None]
        serialized.append({
            "id": route_id, "label": f"Route {chr(65 + index)}",
            "geometry": {"type": "LineString", "coordinates": simplify(route.coords)},
            "distance_mi": route.distance_mi, "drive_time_s": route.drive_time_s,
            "total_time_s": total_time, "departure": utc_iso(departure),
            "arrival": utc_iso(departure + timedelta(seconds=total_time)),
            "summary": {"miles_by_level": dict(score.miles_by_level), "avg_risk": score.avg_risk,
                        "max_level": int(max(known)) if known else None,
                        "weather_coverage": coverage, "checkpoint_count": len(points),
                        "breaks": serialize_breaks(route, departure, hos)},
            "checkpoints": evaluated,
        })
    ranked: list[RouteScore] = rank_routes(scores)
    ranks = {score.route_id: index + 1 for index, score in enumerate(ranked)}
    for route in serialized:
        route["rank"] = ranks[route["id"]]
        route["recommended"] = route["rank"] == 1
    if all(score.miles_by_level["no_travel"] > 0 for score in scores):
        warnings.append("No route is currently safe; consider a later departure")
    if all(score.miles_by_level["unknown"] > 0 for score in scores):
        warnings.append("No route has full weather coverage; the recommendation is provisional.")
    route_id = ranked[0].route_id
    result = {
        "plan_id": uuid4().hex[:12], "generated_at": utc_iso(timezone.now()),
        "request": data | {"departure": utc_iso(departure)}, "recommended_route_id": route_id,
        "recommendation": {"route_id": route_id, "explanation": explain(
            ranked, {r["id"]: r["label"] for r in serialized})},
        "warnings": warnings, "routes": serialized,
    }
    cache.set(f"plan:{result['plan_id']}", result, 6 * 3600)
    return result
