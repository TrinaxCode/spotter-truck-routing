"""Spec-level checks for planner.services.recommend (SPEC sections 6 and 11).

Ranking key (ascending, lexicographic): no_travel_mi (0.1), severe_mi (0.1), high_mi (0.1),
avg_risk (0.01), total_time_s.

OPEN POINTS in the SPEC (deliberately not pinned):
  * avg_risk when EVERY checkpoint is unknown (division by zero): only "does not raise" is asserted.
  * Order of routes that tie on the full key.
  * Exact wording of explain(); only the SPEC 6 example shape is checked softly.
"""
import itertools
import re

import pytest

from planner.services.recommend import RouteScore, explain, rank_routes, score_route
from planner.services.risk import RiskLevel

L, M, H, S, N = (
    RiskLevel.LOW,
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)


def rs(route_id, *, low=0.0, moderate=0.0, high=0.0, severe=0.0, no_travel=0.0, unknown=0.0,
       avg=0.0, time=10_000.0):
    return RouteScore(
        route_id=route_id,
        miles_by_level={
            "low": low, "moderate": moderate, "high": high,
            "severe": severe, "no_travel": no_travel, "unknown": unknown,
        },
        avg_risk=avg,
        total_time_s=time,
    )


def order(scores):
    return [s.route_id for s in rank_routes(scores)]


# --------------------------------------------------------------------------- #
# score_route
# --------------------------------------------------------------------------- #
def test_score_route_buckets_miles_and_averages_risk():
    s = score_route("r1", [10, 20, 30, 40], [L, M, H, None], 5000)
    assert s.route_id == "r1"
    assert s.total_time_s == 5000
    mbl = s.miles_by_level
    assert set(mbl) == {"low", "moderate", "high", "severe", "no_travel", "unknown"}
    assert mbl["low"] == pytest.approx(10)
    assert mbl["moderate"] == pytest.approx(20)
    assert mbl["high"] == pytest.approx(30)
    assert mbl["severe"] == pytest.approx(0)
    assert mbl["no_travel"] == pytest.approx(0)
    assert mbl["unknown"] == pytest.approx(40)
    assert sum(mbl.values()) == pytest.approx(100)
    # (0*10 + 1*20 + 2*30) / 60  -- unknown miles excluded
    assert s.avg_risk == pytest.approx(80 / 60, abs=0.01)


def test_score_route_severe_and_no_travel_buckets():
    s = score_route("r2", [5, 7, 11], [S, N, S], 1)
    assert s.miles_by_level["severe"] == pytest.approx(16)
    assert s.miles_by_level["no_travel"] == pytest.approx(7)
    assert s.avg_risk == pytest.approx((3 * 5 + 4 * 7 + 3 * 11) / 23, abs=0.01)


@pytest.mark.parametrize(
    "owned, levels, expected",
    [
        ([10, 90], [L, None], 0.0),
        ([10, 90], [H, None], 2.0),
        ([10, 30, 60], [S, L, None], 0.75),
        ([50, 50], [N, L], 2.0),
    ],
)
def test_unknown_levels_are_excluded_from_avg_risk(owned, levels, expected):
    assert score_route("r", owned, levels, 1).avg_risk == pytest.approx(expected, abs=0.01)


def test_score_route_all_unknown_does_not_raise():
    s = score_route("r", [40, 60], [None, None], 1)
    assert s.miles_by_level["unknown"] == pytest.approx(100)
    assert s.miles_by_level["low"] == 0


# --------------------------------------------------------------------------- #
# rank_routes: every tie-break level, both input orders
# --------------------------------------------------------------------------- #
# Each case: (winner, loser). The loser is better on every LATER criterion, so only the
# criterion under test can explain the order.
TIE_BREAK_CASES = [
    pytest.param(
        rs("win", no_travel=0, severe=100, high=100, avg=3.9, time=10**6),
        rs("lose", no_travel=5, severe=0, high=0, avg=0.1, time=1),
        id="1-no_travel-before-severe",
    ),
    pytest.param(
        rs("win", severe=5, high=500, avg=3.0, time=99_999),
        rs("lose", severe=10, high=0, avg=0.1, time=1),
        id="2-severe",
    ),
    pytest.param(
        rs("win", severe=3, high=10, avg=3.0, time=99_999),
        rs("lose", severe=3, high=20, avg=0.1, time=1),
        id="3-high",
    ),
    pytest.param(
        rs("win", severe=3, high=10, avg=0.42, time=99_999),
        rs("lose", severe=3, high=10, avg=0.61, time=1),
        id="4-avg_risk",
    ),
    pytest.param(
        rs("win", severe=3, high=10, avg=0.42, time=4_000),
        rs("lose", severe=3, high=10, avg=0.42, time=5_000),
        id="5-total_time",
    ),
]


@pytest.mark.parametrize("winner, loser", TIE_BREAK_CASES)
def test_rank_order_each_tie_break_level(winner, loser):
    assert order([winner, loser]) == ["win", "lose"]
    assert order([loser, winner]) == ["win", "lose"]


def test_no_travel_ranks_worse_than_severe():
    # A route with a tiny bit of No Travel loses to one with lots of Severe.
    assert order([rs("nt", no_travel=0.5), rs("sev", severe=400)]) == ["sev", "nt"]


def test_three_routes_full_order_independent_of_input_order():
    a = rs("a", severe=0, high=50, avg=1.0, time=9000)
    b = rs("b", severe=0, high=20, avg=1.5, time=12000)
    c = rs("c", severe=4, high=0, avg=0.2, time=7000)
    expected = ["b", "a", "c"]
    for perm in itertools.permutations([a, b, c]):
        assert order(list(perm)) == expected


def test_rank_returns_list_with_every_route_once():
    inp = [rs("x", time=3), rs("y", time=2), rs("z", time=1)]
    out = rank_routes(inp)
    assert isinstance(out, list)
    assert sorted(s.route_id for s in out) == ["x", "y", "z"]
    assert order(inp) == ["z", "y", "x"]


def test_full_weather_coverage_outranks_partial_coverage():
    # SPEC §6 (amended): missing weather must never make a route look safer.
    a = rs("a", unknown=300, time=100)
    b = rs("b", unknown=0, time=200)
    assert order([b, a]) == ["b", "a"]


# --------------------------------------------------------------------------- #
# Rounding tolerance (0.1 mi for no_travel/severe/high, 0.01 for avg_risk)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "field, next_field",
    [("no_travel", "severe"), ("severe", "high"), ("high", "avg")],
)
def test_mile_criteria_tie_when_equal_after_rounding_to_a_tenth(field, next_field):
    # 10.04 and 10.01 both round to 10.0 -> tie -> NEXT criterion decides, not the raw value.
    raw_better = rs("raw_better", **{field: 10.01, next_field: 8.0 if next_field != "avg" else 0.9})
    next_better = rs(
        "next_better", **{field: 10.04, next_field: 5.0 if next_field != "avg" else 0.3}
    )
    assert order([raw_better, next_better]) == ["next_better", "raw_better"]
    assert order([next_better, raw_better]) == ["next_better", "raw_better"]


def test_severe_10_04_vs_10_01_ties_then_high_decides():
    a = rs("a", severe=10.04, high=5.0)
    b = rs("b", severe=10.01, high=8.0)
    assert order([a, b]) == ["a", "b"]
    assert order([b, a]) == ["a", "b"]


@pytest.mark.parametrize("field", ["no_travel", "severe", "high"])
def test_mile_criteria_differ_when_rounded_values_differ(field):
    # 10.04 -> 10.0, 10.06 -> 10.1: the criterion itself decides, later criteria are ignored.
    better = rs("better", **{field: 10.04}, avg=3.9, time=10**6)
    worse = rs("worse", **{field: 10.06}, avg=0.1, time=1)
    assert order([worse, better]) == ["better", "worse"]
    assert order([better, worse]) == ["better", "worse"]


def test_avg_risk_ties_when_equal_after_rounding_to_two_decimals():
    # 0.4204 -> 0.42, 0.4249 -> 0.42: tie -> total time decides.
    slow = rs("slow", avg=0.4204, time=100)
    fast = rs("fast", avg=0.4249, time=50)
    assert order([slow, fast]) == ["fast", "slow"]
    assert order([fast, slow]) == ["fast", "slow"]


def test_avg_risk_differs_when_rounded_values_differ():
    # 0.4249 -> 0.42, 0.4351 -> 0.44: avg_risk decides even though the other is faster.
    low = rs("low", avg=0.4249, time=999)
    high = rs("high", avg=0.4351, time=1)
    assert order([high, low]) == ["low", "high"]


# --------------------------------------------------------------------------- #
# explain()
# --------------------------------------------------------------------------- #
def _explain(*scores):
    out = explain(rank_routes(list(scores)))
    assert isinstance(out, list)
    return out


@pytest.mark.parametrize(
    "scores",
    [
        [rs("a", no_travel=5), rs("b")],
        [rs("a", severe=5), rs("b", severe=1)],
        [rs("a", high=50), rs("b", high=10)],
        [rs("a", avg=0.61), rs("b", avg=0.42)],
        [rs("a", time=9000), rs("b", time=4000)],
        [rs("a", time=100), rs("b", time=100), rs("c", time=100)],  # complete tie
        [rs("a", severe=9), rs("b", severe=1), rs("c", severe=4)],
    ],
    ids=["no_travel", "severe", "high", "avg", "time", "full-tie", "three-routes"],
)
def test_explain_is_non_empty_for_two_or_more_routes(scores):
    lines = _explain(*scores)
    assert len(lines) >= 1
    assert all(isinstance(x, str) and x.strip() for x in lines)


def test_explain_single_route_does_not_raise():
    out = explain(rank_routes([rs("only")]))
    assert isinstance(out, list)
    assert all(isinstance(x, str) for x in out)


def test_explain_avg_risk_decider_quotes_both_values_like_spec_example():
    # SPEC 6 example: "Tied on Severe/High miles; lower average risk (0.42 vs 0.61)"
    a = rs("a", severe=3, high=10, avg=0.61)
    b = rs("b", severe=3, high=10, avg=0.42)
    text = " ".join(_explain(a, b))
    assert "0.42" in text and "0.61" in text


def test_explain_names_the_deciding_criterion():
    sev = " ".join(_explain(rs("a", severe=12.3), rs("b", severe=0))).lower()
    assert "severe" in sev
    high = " ".join(_explain(rs("a", high=40), rs("b", high=5))).lower()
    assert "high" in high
    nt = " ".join(_explain(rs("a", no_travel=9), rs("b", no_travel=0))).lower()
    assert re.search(r"no[ _-]?travel", nt)
    tm = " ".join(_explain(rs("a", time=9000), rs("b", time=4000))).lower()
    assert any(w in tm for w in ("time", "faster", "shorter", "quicker", "duration"))
