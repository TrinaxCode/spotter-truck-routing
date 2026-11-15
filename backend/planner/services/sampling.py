from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from math import asin, cos, isfinite, radians, sin, sqrt

Coord = tuple[float, float]
METERS_PER_MILE = 1609.344
EARTH_RADIUS_MI = 3958.7613


def haversine(a: Coord, b: Coord) -> float:
    lon1, lat1, lon2, lat2 = map(radians, (*a, *b))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_MI * asin(min(1, sqrt(h)))


@dataclass(frozen=True)
class Checkpoint:
    index: int
    mile: float
    lon: float
    lat: float


def sample_checkpoints(
    coords: Sequence[tuple[float, float]], interval_mi: float,
    total_distance_mi: float | None = None,
) -> list[Checkpoint]:
    if not coords or not isfinite(interval_mi) or interval_mi <= 0:
        raise ValueError("Coordinates and a positive interval are required.")
    cumulative = [0.0]
    for a, b in zip(coords, coords[1:], strict=False):
        cumulative.append(cumulative[-1] + haversine(a, b))
    length = cumulative[-1]
    total = length if total_distance_mi is None else total_distance_mi
    if not isfinite(total) or total < 0:
        raise ValueError("Invalid route distance.")
    if total == 0:
        return [Checkpoint(0, 0, *coords[-1])]
    if length == 0:
        raise ValueError("Nonzero route distance needs nonzero geometry.")
    miles = [i * interval_mi for i in range(int(total / interval_mi) + 1)]
    if total - miles[-1] > 1e-9:
        miles.append(total)
    else:
        miles[-1] = total
    checkpoints = []
    for index, mile in enumerate(miles):
        target = mile / total * length
        segment = min(len(coords) - 2, bisect_right(cumulative, target) - 1)
        gap = cumulative[segment + 1] - cumulative[segment]
        fraction = (target - cumulative[segment]) / gap if gap else 0
        a, b = coords[segment], coords[segment + 1]
        lon, lat = (a[d] + fraction * (b[d] - a[d]) for d in (0, 1))
        if index == len(miles) - 1:
            lon, lat = coords[-1]
        checkpoints.append(Checkpoint(index, mile, lon, lat))
    return checkpoints


def owned_miles(checkpoint_miles: Sequence[float], total_mi: float) -> list[float]:
    if not checkpoint_miles:
        return []
    if (not isfinite(total_mi) or total_mi < 0
            or any(not isfinite(x) or x < 0 or x > total_mi for x in checkpoint_miles)
            or any(b < a for a, b in zip(checkpoint_miles, checkpoint_miles[1:], strict=False))):
        raise ValueError("Checkpoint distances must be ordered inside the route.")
    gaps = zip(checkpoint_miles, checkpoint_miles[1:], strict=False)
    edges = [0.0, *[(a + b) / 2 for a, b in gaps],
             total_mi]
    return [b - a for a, b in zip(edges, edges[1:], strict=False)]


def distance_to_segment(point: Coord, a: Coord, b: Coord) -> float:
    # Local equirectangular projection, returned in miles; avoids vertex-only proximity.
    scale = cos(radians(point[1]))
    ax, ay = (a[0] - point[0]) * scale, a[1] - point[1]
    bx, by = (b[0] - point[0]) * scale, b[1] - point[1]
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0
    return sqrt((ax + t * dx) ** 2 + (ay + t * dy) ** 2) * 69.0934


def distance_to_polyline(point: Coord, coords: Sequence[Coord]) -> float:
    return min(distance_to_segment(point, a, b) for a, b in zip(coords, coords[1:], strict=False))


def simplify(coords: Sequence[Coord], tolerance: float = .0005) -> list[Coord]:
    """Iterative Douglas–Peucker in degrees; coarsen to the response's 3000-point cap."""
    def reduce_points(epsilon: float) -> list[Coord]:
        keep = {0, len(coords) - 1}
        stack = [(0, len(coords) - 1)]
        while stack:
            start, end = stack.pop()
            a, b = coords[start], coords[end]
            dx, dy = b[0] - a[0], b[1] - a[1]
            norm = dx * dx + dy * dy
            maximum, at = 0.0, start
            for i in range(start + 1, end):
                x, y = coords[i][0] - a[0], coords[i][1] - a[1]
                t = max(0, min(1, (x * dx + y * dy) / norm)) if norm else 0
                distance = sqrt((x - t * dx) ** 2 + (y - t * dy) ** 2)
                if distance > maximum:
                    maximum, at = distance, i
            if maximum > epsilon:
                keep.add(at)
                stack.extend([(start, at), (at, end)])
        return [coords[i] for i in sorted(keep)]

    if len(coords) < 3:
        return list(coords)
    result = reduce_points(tolerance)
    while len(result) > 3000:
        tolerance *= 2
        result = reduce_points(tolerance)
    return result
