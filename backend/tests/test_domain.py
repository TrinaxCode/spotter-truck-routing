import math

import pytest

from planner.services.hos import break_schedule, elapsed_with_breaks
from planner.services.recommend import RouteScore, explain, rank_routes, score_route
from planner.services.risk import (
    RiskLevel,
    assess,
    rain_level,
    snow_level,
    wind_level,
    wind_level_with_load,
)
from planner.services.sampling import owned_miles, sample_checkpoints


@pytest.mark.parametrize("threshold,below,at", [(25, 0, 1), (35, 1, 2), (45, 2, 3), (55, 3, 4)])
def test_wind_boundaries(threshold, below, at):
    assert wind_level(threshold - 1e-7) == below
    assert wind_level(threshold) == at
    assert wind_level(threshold + 1e-7) == at


@pytest.mark.parametrize("function,threshold,below,at,above", [
    (rain_level, .1, 0, 1, 1), (rain_level, .25, 1, 2, 2),
    (rain_level, .5, 2, 3, 3), (rain_level, 1, 3, 3, 4),
    (snow_level, .5, 0, 1, 1), (snow_level, 1, 1, 2, 2),
    (snow_level, 2, 2, 3, 3), (snow_level, 3, 3, 3, 4),
])
def test_precipitation_boundaries(function, threshold, below, at, above):
    assert function(threshold - 1e-7) == below
    assert function(threshold) == at
    assert function(threshold + 1e-7) == above


@pytest.mark.parametrize("wind,load,level", [
    (34.999, 80000, 1), (35, 40000, 2), (35, 40001, 3),
    (44.999, 40001, 3), (45, 30000, 3), (45, 30001, 4),
    (54.999, 30001, 4), (55, 0, 4), (55, 80000, 4),
])
def test_load_only_escalates(wind, load, level):
    assert wind_level_with_load(wind, load) == level
    assert wind_level_with_load(wind, load) >= wind_level(wind)


def test_assessment_max_and_reasons():
    result = assess(35, 1.01, 0, 40001)
    assert (result.wind, result.rain, result.snow, result.level) == (3, 4, 0, 4)
    assert result.reasons
    assert assess(1, 0, 0, 0).reasons == ()
    assert isinstance(result.level, RiskLevel)


@pytest.mark.parametrize("function", [wind_level, rain_level, snow_level])
@pytest.mark.parametrize("value", [-1, math.nan, math.inf])
def test_nonphysical_weather_rejected(function, value):
    with pytest.raises(ValueError):
        function(value)


def test_scaled_checkpoints_always_include_destination_and_keep_coordinate_order():
    points = sample_checkpoints([(-100, 30), (-99, 30), (-98, 30)], 25, 101)
    assert [p.mile for p in points] == [0, 25, 50, 75, 100, 101]
    assert [(p.index) for p in points] == list(range(6))
    assert (points[0].lon, points[0].lat) == (-100, 30)
    assert (points[-1].lon, points[-1].lat) == (-98, 30)
    assert points[2].lon == pytest.approx(-99.00990099)


def test_exact_multiple_and_degenerate_geometry():
    assert [p.mile for p in sample_checkpoints([(0, 0), (1, 0)], 25, 50)] == [0, 25, 50]
    assert len(sample_checkpoints([(0, 0), (0, 0)], 25, 0)) == 1
    with pytest.raises(ValueError):
        sample_checkpoints([], 25)
    with pytest.raises(ValueError):
        sample_checkpoints([(0, 0), (1, 0)], 0)


def test_ownership_covers_entire_distance_including_short_last_gap():
    assert owned_miles([0, 25, 50, 51], 51) == [12.5, 25, 13, .5]
    assert sum(owned_miles([0, 25, 50, 51], 51)) == 51
    assert owned_miles([0], 0) == [0]


@pytest.mark.parametrize("drive,elapsed", [
    (0, 0), (8, 8), (8.1, 8.6), (11, 11.5), (12, 22.5),
    (19, 29.5), (19.1, 30.1), (22, 33), (23, 44),
])
def test_hos_arrival_does_not_require_post_trip_rest(drive, elapsed):
    assert elapsed_with_breaks(drive * 3600) == pytest.approx(elapsed * 3600)
    assert elapsed_with_breaks(drive * 3600, False) == drive * 3600


def test_break_schedule_has_cumulative_driving_offsets():
    assert [(b.type, b.drive_seconds_at, b.duration_s) for b in break_schedule(20 * 3600)] == [
        ("break_30m", 8 * 3600, 1800), ("rest_10h", 11 * 3600, 36000),
        ("break_30m", 19 * 3600, 1800),
    ]


def test_weighted_score_excludes_unknown():
    score = score_route("r", [10, 20, 30], [RiskLevel.LOW, RiskLevel.HIGH, None], 100)
    assert score.avg_risk == pytest.approx(40 / 30)
    assert score.miles_by_level["unknown"] == 30
    assert score.miles_by_level["high"] == 20
    assert score_route("r", [10], [None], 100).avg_risk == 0


@pytest.mark.parametrize("levels", [[None, None], [RiskLevel.LOW, None]])
def test_incomplete_coverage_never_beats_full_coverage(levels):
    incomplete = score_route("incomplete", [50, 50], levels, 1)
    complete = score_route("complete", [50, 50], [RiskLevel.NO_TRAVEL] * 2, 10000)
    ranked = rank_routes([incomplete, complete])
    assert ranked[0] == complete
    assert "coverage" in " ".join(explain(ranked)).lower()


@pytest.mark.parametrize("a,b,criterion", [
    ((0, 100, 100, 4, 1000), (1, 0, 0, 0, 1), "No Travel"),
    ((0, 0, 100, 4, 1000), (0, 1, 0, 0, 1), "Severe"),
    ((0, 0, 0, 4, 1000), (0, 0, 1, 0, 1), "High"),
    ((0, 0, 0, .42, 1000), (0, 0, 0, .61, 1), "average"),
    ((0, 0, 0, .42, 100), (0, 0, 0, .42, 101), "time"),
])
def test_each_lexicographic_tiebreak(a, b, criterion):
    def make(route_id, values):
        nt, severe, high, average, time = values
        return RouteScore(route_id, {"no_travel": nt, "severe": severe, "high": high},
                          average, time)
    ranked = rank_routes([make("b", b), make("a", a)])
    assert ranked[0].route_id == "a"
    assert criterion.lower() in " ".join(explain(ranked)).lower()


def test_rounded_tie_uses_travel_time_and_stable_order():
    a = RouteScore("a", {"no_travel": .011}, .421, 100)
    b = RouteScore("b", {"no_travel": .014}, .424, 99)
    assert rank_routes([a, b])[0] == b
    assert rank_routes([a, a]) == [a, a]
    assert explain([]) == []
