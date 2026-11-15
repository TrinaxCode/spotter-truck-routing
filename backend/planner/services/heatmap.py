from datetime import datetime, timedelta
from math import ceil, cos, floor, hypot, radians

from django.core.cache import cache
from rest_framework.exceptions import NotFound

from .http import utc_iso
from .risk import assess
from .sampling import Coord, distance_to_polyline, simplify
from .weather import fetch_forecasts, rounded_coord, select_weather


def corridor_grid(routes: list[list[Coord]]) -> tuple[list[dict[str, float]], float]:
    if not routes or not all(len(route) >= 2 for route in routes):
        raise ValueError("A corridor requires route geometry.")
    points = [point for route in routes for point in route]
    min_lon, max_lon = min(p[0] for p in points), max(p[0] for p in points)
    min_lat, max_lat = min(p[1] for p in points), max(p[1] for p in points)
    cell = max(.15, min(.75, hypot(max_lon - min_lon, max_lat - min_lat) / 25))
    # Much smaller than the minimum cell size, but reduces long provider polylines.
    lines = [simplify(route, .002) for route in routes]
    scale = max(.01, cos(radians(max(abs(min_lat), abs(max_lat)))))
    while True:
        lat_pad = max(30 / 69.0934, 1.5 * cell)
        lon_pad = max(30 / (69.0934 * scale), 1.5 * cell)
        x0 = floor(max(-180, min_lon - lon_pad) / cell)
        x1 = ceil(min(180, max_lon + lon_pad) / cell)
        y0 = floor(max(-90, min_lat - lat_pad) / cell)
        y1 = ceil(min(90, max_lat + lat_pad) / cell)
        # Bound work before evaluating corridor distances on very long routes.
        if (x1 - x0) * (y1 - y0) > 10000:
            cell *= 1.25
            continue
        cells = []
        for y in range(y0, y1):
            lat = (y + .5) * cell
            if not -90 <= lat <= 90:
                continue
            # A square cell's latitude side defines its corridor radius in miles.
            radius = max(30, 1.5 * cell * 69.0934)
            for x in range(x0, x1):
                lon = (x + .5) * cell
                if -180 <= lon <= 180 and any(
                    distance_to_polyline((lon, lat), route) <= radius for route in lines
                ):
                    cells.append({"lat": round(lat, 6), "lon": round(lon, 6)})
        if len(cells) <= 300:
            return cells, round(cell, 8)
        # SPEC's 300-cell cap takes precedence over the initial .75-degree clamp.
        cell *= 1.25


def get_heatmap(plan_id: str) -> dict:
    plan = cache.get(f"plan:{plan_id}")
    if plan is None:
        raise NotFound("Plan is unknown or expired. Please create a new plan.")
    existing = cache.get(f"heatmap:{plan_id}")
    if existing is not None:
        return existing
    coords = [route["geometry"]["coordinates"] for route in plan["routes"]]
    cells, cell_deg = corridor_grid(coords)
    forecasts = fetch_forecasts([(c["lon"], c["lat"]) for c in cells])
    start = datetime.fromisoformat(plan["request"]["departure"]).replace(
        minute=0, second=0, microsecond=0)
    result = {"plan_id": plan_id, "start": utc_iso(start), "hours": 49,
              "cell_deg": cell_deg, "load_lbs": plan["request"]["load_lbs"], "cells": cells,
              "risk": [], "wind": [], "rain": [], "snow": []}
    for cell in cells:
        row = {variable: [] for variable in ("risk", "wind", "rain", "snow")}
        forecast = forecasts[rounded_coord((cell["lon"], cell["lat"]))]
        for hour in range(49):
            weather = select_weather(forecast, start + timedelta(hours=hour))
            values = (None, None, None, None)
            if weather is not None:
                assessment = assess(weather.wind_mph, weather.rain_in_hr, weather.snow_in_hr,
                                    result["load_lbs"])
                values = (int(assessment.level), round(weather.wind_mph, 2),
                          round(weather.rain_in_hr, 2), round(weather.snow_in_hr, 2))
            for variable, value in zip(row, values, strict=True):
                row[variable].append(value)
        for variable in row:
            result[variable].append(row[variable])
    cache.set(f"heatmap:{plan_id}", result, 6 * 3600)
    return result
