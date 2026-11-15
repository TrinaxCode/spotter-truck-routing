from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .risk import LEVEL_KEYS, RiskLevel, nonnegative


@dataclass(frozen=True)
class RouteScore:
    route_id: str
    miles_by_level: Mapping[str, float]
    avg_risk: float
    total_time_s: float


def score_route(
    route_id: str, owned: Sequence[float], levels: Sequence[RiskLevel | None], total_time_s: float,
) -> RouteScore:
    if len(owned) != len(levels):
        raise ValueError("Every checkpoint needs its owned distance and level.")
    miles = dict.fromkeys((*LEVEL_KEYS, "unknown"), 0.0)
    weighted = known = 0.0
    for distance, level in zip(owned, levels, strict=True):
        nonnegative(distance)
        miles[LEVEL_KEYS[level] if level is not None else "unknown"] += distance
        if level is not None:
            known += distance
            weighted += distance * int(level)
    return RouteScore(route_id, miles, weighted / known if known else 0.0,
                      nonnegative(total_time_s))


def ranking_key(score: RouteScore) -> tuple[float, ...]:
    return (float(score.miles_by_level.get("unknown", 0) > 0),
            *(round(score.miles_by_level.get(key, 0), 1)
              for key in ("no_travel", "severe", "high")),
            round(score.avg_risk, 2), score.total_time_s)


def rank_routes(scores: Sequence[RouteScore]) -> list[RouteScore]:
    return sorted(scores, key=ranking_key)


def format_duration(seconds: float) -> str:
    minutes = round(seconds / 60)
    return f"{minutes // 60}h {minutes % 60:02d}m"


def explain(ranked: Sequence[RouteScore], labels: Mapping[str, str] | None = None) -> list[str]:
    if not ranked:
        return []
    if len(ranked) == 1:
        return ["Only one distinct route is available; no comparison is possible."]
    best, second = ranked[:2]
    runner_up = (labels or {}).get(second.route_id, second.route_id)
    if ranking_key(best)[0] != ranking_key(second)[0]:
        return [f"Full weather coverage takes priority over incomplete coverage on {runner_up}."]
    criteria = ("No Travel miles", "Severe miles", "High miles", "average risk", "total trip time")
    comparisons = zip(ranking_key(best)[1:], ranking_key(second)[1:], strict=True)
    for index, (a, b) in enumerate(comparisons):
        if a != b:
            tied = criteria[:index]
            joined = ", ".join(tied[:-1]) + " and " + tied[-1] if len(tied) > 1 else "".join(tied)
            prefix = f"Tied on {joined}; " if index else ""
            values = (f"{format_duration(a)} vs {format_duration(b)}" if index == 4
                      else f"{a:g} vs {b:g}")
            comparative = "fewer" if index < 3 else "lower"
            return [f"{prefix}{comparative} {criteria[index]} ({values}) than {runner_up}."]
    return ["All ranking criteria are tied; provider order breaks the tie."]
