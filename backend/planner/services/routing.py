from bisect import bisect_right
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from math import cos, isfinite, radians
from typing import Protocol

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from planner.exceptions import NotConfigured, ProviderBudgetExhausted, UpstreamError

from .budget import spend
from .http import cache_key, get_json, utc_iso
from .sampling import (
    METERS_PER_MILE,
    Coord,
    distance_to_polyline,
    sample_checkpoints,
    simplify,
)


def interpolate(value: float, pairs: Sequence[tuple[float, float]]) -> float:
    index = min(len(pairs) - 2, max(0, bisect_right([p[0] for p in pairs], value) - 1))
    (x0, y0), (x1, y1) = pairs[index:index + 2]
    return y0 + (y1 - y0) * max(0, min(1, (value - x0) / (x1 - x0)))


@dataclass(frozen=True)
class Route:
    coords: tuple[Coord, ...]
    distance_mi: float
    drive_time_s: float
    time_offsets: tuple[tuple[float, float], ...]

    def drive_seconds_at(self, mile: float) -> float:
        pairs = self.time_offsets or ((0, 0), (self.distance_mi, self.drive_time_s))
        return interpolate(mile, pairs)

    def mile_at_drive(self, seconds: float) -> float:
        pairs = self.time_offsets or ((0, 0), (self.distance_mi, self.drive_time_s))
        # Repeated times can occur in rounded guidance; retain the furthest distance.
        inverse = dict((t, mile) for mile, t in pairs)
        if len(inverse) < 2:
            return 0
        return interpolate(seconds, sorted(inverse.items()))


# Coast-to-coast truck routes with alternatives take ~16 s at TomTom.
ROUTING_TIMEOUT_S = 45


class RoutingProvider(Protocol):
    def calculate_routes(
        self, origin: Coord, destination: Coord, departure: datetime, load_lbs: int,
        via: Coord | None = None, max_alternatives: int = 2,
    ) -> list[Route]: ...


def parse_route(raw: dict) -> Route:
    summary = raw["summary"]
    distance = float(summary["lengthInMeters"]) / METERS_PER_MILE
    seconds = float(summary["travelTimeInSeconds"])
    coords = tuple((float(p["longitude"]), float(p["latitude"]))
                   for leg in raw["legs"] for p in leg["points"])
    if (not isfinite(distance) or distance <= 0 or not isfinite(seconds) or seconds <= 0
            or len(coords) < 2 or not any(a != b for a, b in zip(coords, coords[1:], strict=False))
            or any(not (-180 <= lon <= 180 and -90 <= lat <= 90) for lon, lat in coords)):
        raise ValueError("Invalid route geometry or summary")
    offsets = [(0.0, 0.0)]
    for instruction in raw.get("guidance", {}).get("instructions", []):
        mile = float(instruction["routeOffsetInMeters"]) / METERS_PER_MILE
        time = float(instruction["travelTimeInSeconds"])
        if not (isfinite(mile) and isfinite(time)):
            raise ValueError("Invalid guidance")
        if 0 < mile < distance and 0 <= time <= seconds:
            if mile < offsets[-1][0] or time < offsets[-1][1]:
                raise ValueError("Nonmonotonic guidance")
            if mile == offsets[-1][0]:
                offsets[-1] = (mile, time)
                continue
            offsets.append((mile, time))
    offsets.append((distance, seconds))
    return Route(coords, distance, seconds, tuple(offsets))


def depart_at(departure: datetime) -> str:
    """TomTom rejects past departures; a just-passed departure is routed as "now"."""
    return utc_iso(departure) if departure > timezone.now() else "now"


class TomTomProvider:
    def calculate_routes(
        self, origin: Coord, destination: Coord, departure: datetime, load_lbs: int,
        via: Coord | None = None, max_alternatives: int = 2,
    ) -> list[Route]:
        if not settings.TOMTOM_API_KEY:
            raise NotConfigured()
        points = (origin, via, destination) if via else (origin, destination)
        # `:g` keeps 6 significant digits, which truncates longitudes west of -100 to ~100 m.
        locations = ":".join(f"{lat:.6f},{lon:.6f}" for lon, lat in points)
        spend("tomtom")
        payload = get_json(f"https://api.tomtom.com/routing/1/calculateRoute/{locations}/json", {
            "key": settings.TOMTOM_API_KEY, "travelMode": "truck", "vehicleCommercial": "true",
            "vehicleWeight": round((load_lbs + settings.TRUCK_TARE_LBS) * .45359237),
            "maxAlternatives": max_alternatives, "departAt": depart_at(departure),
            "routeRepresentation": "polyline", "instructionsType": "coded",
        }, timeout=ROUTING_TIMEOUT_S)
        try:
            routes = [parse_route(raw) for raw in payload["routes"]]
            if not routes:
                raise ValueError("No route")
            return routes
        except (KeyError, TypeError, ValueError, AttributeError):
            raise UpstreamError() from None


def distinct(candidate: Route, existing: Sequence[Route]) -> bool:
    samples = sample_checkpoints(candidate.coords, max(candidate.distance_mi / 100, .1),
                                 candidate.distance_mi)
    # ~0.35 mi simplification error is far below the 2 mi proximity threshold.
    lines = [simplify(route.coords, .005) for route in existing]
    return all(sum(distance_to_polyline((p.lon, p.lat), line) <= 2 for p in samples)
               / len(samples) < .8 for line in lines)


def via_points(origin: Coord, destination: Coord) -> list[Coord]:
    lon, lat = ((a + b) / 2 for a, b in zip(origin, destination, strict=True))
    scale = max(.01, cos(radians(lat)))
    dx = (destination[0] - origin[0]) * scale
    dy = destination[1] - origin[1]
    return [(((lon - dy * ratio / scale + 180) % 360) - 180,
             max(-89.9, min(89.9, lat + dx * ratio))) for ratio in (.15, -.15, .3, -.3)]


def get_routes(
    origin: Coord, destination: Coord, departure: datetime, load_lbs: int,
    provider: RoutingProvider | None = None,
) -> tuple[list[Route], list[str]]:
    use_cache = provider is None
    if use_cache and not settings.TOMTOM_API_KEY:
        raise NotConfigured()
    key = cache_key("routes", origin, destination, utc_iso(departure.replace(minute=0, second=0,
                                                                          microsecond=0)),
                    load_lbs, settings.TRUCK_TARE_LBS)
    cached = cache.get(key) if use_cache else None
    if cached is not None:
        return cached
    provider = provider or TomTomProvider()
    result: list[Route] = []

    def add(candidates: Sequence[Route]) -> None:
        for route in candidates:
            if len(result) < 3 and distinct(route, result):
                result.append(route)

    add(provider.calculate_routes(origin, destination, departure, load_lbs))
    if len(result) < 3:
        # Long truck routes take seconds each, so request every via-point route at once and
        # still consider them in via_points() order (±15% before ±30%).
        def via_route(via: Coord) -> list[Route]:
            try:
                return provider.calculate_routes(origin, destination, departure, load_lbs,
                                                 via=via, max_alternatives=0)
            except (UpstreamError, ProviderBudgetExhausted):
                # A via point can be inaccessible, or the day's budget can run out mid-search;
                # either way keep the real routes already found.
                return []

        vias = via_points(origin, destination)
        with ThreadPoolExecutor(max_workers=len(vias)) as pool:
            for candidates in pool.map(via_route, vias):
                add(candidates)
    if not result:
        raise UpstreamError()
    warnings = ([f"Only {len(result)} distinct route(s) found; fewer than 3 are available."]
                if len(result) < 3 else [])
    if use_cache:
        cache.set(key, (result, warnings), 15 * 60)
    return result, warnings
