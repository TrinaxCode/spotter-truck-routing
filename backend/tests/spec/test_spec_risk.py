"""Spec-level checks for planner.services.risk (SPEC sections 4 and 11).

Boundary convention (SPEC 4): lower bound inclusive, upper bound exclusive, except
the "Severe" rain/snow top bound which is inclusive (> 1.00 / > 3.0 is No Travel).
"""
import dataclasses

import pytest

from planner.services.risk import (
    Assessment,
    RiskLevel,
    assess,
    rain_level,
    snow_level,
    wind_level,
    wind_level_with_load,
)

LOW, MOD, HIGH, SEV, NOTRAVEL = (
    RiskLevel.LOW,
    RiskLevel.MODERATE,
    RiskLevel.HIGH,
    RiskLevel.SEVERE,
    RiskLevel.NO_TRAVEL,
)


def test_risk_level_is_ordered_int_enum():
    assert [int(x) for x in (LOW, MOD, HIGH, SEV, NOTRAVEL)] == [0, 1, 2, 3, 4]
    assert LOW < MOD < HIGH < SEV < NOTRAVEL
    assert max(HIGH, SEV) == SEV


# --------------------------------------------------------------------------- #
# Single-condition thresholds, both sides of every boundary
# --------------------------------------------------------------------------- #
WIND_CASES = [
    (0, LOW), (10, LOW), (24.99, LOW),
    (25, MOD), (30, MOD), (34.99, MOD),
    (35, HIGH), (40, HIGH), (44.99, HIGH),
    (45, SEV), (50, SEV), (54.99, SEV),
    (55, NOTRAVEL), (55.01, NOTRAVEL), (90, NOTRAVEL),
]
RAIN_CASES = [
    (0, LOW), (0.05, LOW), (0.0999, LOW),
    (0.10, MOD), (0.2, MOD), (0.2499, MOD),
    (0.25, HIGH), (0.4, HIGH), (0.4999, HIGH),
    (0.50, SEV), (0.75, SEV), (1.00, SEV),
    (1.0001, NOTRAVEL), (5.0, NOTRAVEL),
]
SNOW_CASES = [
    (0, LOW), (0.2, LOW), (0.499, LOW),
    (0.5, MOD), (0.75, MOD), (0.999, MOD),
    (1.0, HIGH), (1.5, HIGH), (1.999, HIGH),
    (2.0, SEV), (2.5, SEV), (3.0, SEV),
    (3.0001, NOTRAVEL), (8.0, NOTRAVEL),
]


@pytest.mark.parametrize("value, expected", WIND_CASES)
def test_wind_level_thresholds(value, expected):
    assert wind_level(value) == expected


@pytest.mark.parametrize("value, expected", RAIN_CASES)
def test_rain_level_thresholds(value, expected):
    assert rain_level(value) == expected


@pytest.mark.parametrize("value, expected", SNOW_CASES)
def test_snow_level_thresholds(value, expected):
    assert snow_level(value) == expected


@pytest.mark.parametrize(
    "fn, cases",
    [(wind_level, WIND_CASES), (rain_level, RAIN_CASES), (snow_level, SNOW_CASES)],
)
def test_single_condition_levels_are_monotonic_in_value(fn, cases):
    values = sorted(v for v, _ in cases)
    levels = [fn(v) for v in values]
    assert levels == sorted(levels)
    assert all(isinstance(lv, RiskLevel) for lv in levels)


# --------------------------------------------------------------------------- #
# Load rules (SPEC 4): only escalate the WIND level
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("load", [0, 1, 30_000, 80_000])
@pytest.mark.parametrize("wind", [55, 55.01, 70])
def test_wind_55_or_more_is_no_travel_for_any_load(wind, load):
    assert wind_level_with_load(wind, load) == NOTRAVEL


@pytest.mark.parametrize("wind", [45, 50, 54.99])
def test_wind_45_to_54_with_30000_lb_is_not_escalated(wind):
    # rule is strictly "> 30,000": 30,000 itself stays Severe
    assert wind_level_with_load(wind, 30_000) == SEV


@pytest.mark.parametrize("wind", [45, 50, 54.99])
@pytest.mark.parametrize("load", [30_001, 30_000.5, 35_000, 80_000])
def test_wind_45_to_54_with_more_than_30000_lb_is_no_travel(wind, load):
    assert wind_level_with_load(wind, load) == NOTRAVEL


@pytest.mark.parametrize("wind", [45, 50, 54.99])
@pytest.mark.parametrize("load", [0, 10_000, 29_999])
def test_wind_45_to_54_light_load_stays_severe(wind, load):
    assert wind_level_with_load(wind, load) == SEV


@pytest.mark.parametrize("wind", [35, 40, 44.99])
@pytest.mark.parametrize("load", [0, 35_000, 40_000])
def test_wind_35_to_44_with_40000_lb_or_less_stays_high(wind, load):
    # rule is strictly "> 40,000": 40,000 itself stays High; 35,000 is under it
    assert wind_level_with_load(wind, load) == HIGH


@pytest.mark.parametrize("wind", [35, 40, 44.99])
@pytest.mark.parametrize("load", [40_001, 40_000.5, 60_000, 80_000])
def test_wind_35_to_44_with_more_than_40000_lb_is_severe(wind, load):
    assert wind_level_with_load(wind, load) == SEV


def test_45_mph_with_35000_lb_hits_30k_rule_not_only_40k_rule():
    # 35,000 lb is under the 40k threshold but over the 30k one, and 45 mph is in the 30k band.
    assert wind_level_with_load(45, 35_000) == NOTRAVEL


@pytest.mark.parametrize("wind", [0, 24.99, 25, 30, 34.99])
@pytest.mark.parametrize("load", [0, 40_001, 80_000])
def test_loads_do_not_change_wind_below_35(wind, load):
    assert wind_level_with_load(wind, load) == wind_level(wind)


@pytest.mark.parametrize("wind", [0, 10, 24.99, 25, 34.99, 35, 40, 44.99, 45, 50, 54.99, 55, 70])
@pytest.mark.parametrize("load", [0, 1, 30_000, 30_001, 40_000, 40_001, 80_000])
def test_load_never_lowers_the_level(wind, load):
    assert wind_level_with_load(wind, load) >= wind_level(wind)


@pytest.mark.parametrize("wind", [10, 34.99, 35, 44.99, 45, 54.99, 55])
def test_heavier_load_never_reduces_level(wind):
    loads = [0, 10_000, 30_000, 30_001, 40_000, 40_001, 80_000]
    levels = [wind_level_with_load(wind, ld) for ld in loads]
    assert levels == sorted(levels)


# --------------------------------------------------------------------------- #
# assess(): max of the three, reasons
# --------------------------------------------------------------------------- #
# (wind, rain, snow, load, expected level, rain level, snow level)
ASSESS_CASES = [
    pytest.param(0, 0, 0, 0, LOW, LOW, LOW, id="all-calm"),
    pytest.param(30, 0, 0, 0, MOD, LOW, LOW, id="wind-moderate"),
    pytest.param(0, 0.3, 0, 0, HIGH, HIGH, LOW, id="rain-high"),
    pytest.param(0, 0, 2.5, 0, SEV, LOW, SEV, id="snow-severe"),
    pytest.param(0, 0, 3.5, 0, NOTRAVEL, LOW, NOTRAVEL, id="snow-no-travel"),
    pytest.param(40, 0.3, 1.2, 35_000, HIGH, HIGH, HIGH, id="three-way-high"),
    pytest.param(40, 0.1, 0, 45_000, SEV, MOD, LOW, id="load-escalates-wind-over-rain"),
    pytest.param(47, 0, 0, 35_000, NOTRAVEL, LOW, LOW, id="spec-example-47mph-35k"),
    pytest.param(47, 0, 0, 30_000, SEV, LOW, LOW, id="47mph-30k-stays-severe"),
    pytest.param(10, 0.6, 0.6, 0, SEV, SEV, MOD, id="rain-beats-snow"),
    pytest.param(20, 0.6, 3.1, 0, NOTRAVEL, SEV, NOTRAVEL, id="snow-beats-rain"),
    pytest.param(56, 2, 4, 0, NOTRAVEL, NOTRAVEL, NOTRAVEL, id="everything-no-travel"),
    pytest.param(55, 0, 0, 0, NOTRAVEL, LOW, LOW, id="55mph-empty-truck"),
    pytest.param(25, 0.10, 0.5, 80_000, MOD, MOD, MOD, id="all-moderate-heavy-load"),
]


@pytest.mark.parametrize("wind, rain, snow, load, level, rain_lv, snow_lv", ASSESS_CASES)
def test_assess_takes_the_maximum(wind, rain, snow, load, level, rain_lv, snow_lv):
    a = assess(wind, rain, snow, load)
    assert isinstance(a, Assessment)
    assert a.level == level
    assert a.rain == rain_lv
    assert a.snow == snow_lv
    assert a.level == max(a.wind, a.rain, a.snow)


@pytest.mark.parametrize("wind, rain, snow, load, level, rain_lv, snow_lv", ASSESS_CASES)
def test_assess_reasons_non_empty_above_low(wind, rain, snow, load, level, rain_lv, snow_lv):
    a = assess(wind, rain, snow, load)
    assert isinstance(a.reasons, tuple)
    assert all(isinstance(r, str) and r.strip() for r in a.reasons)
    if a.level > LOW:
        assert len(a.reasons) >= 1
    else:
        # SPEC 7 example: a Low checkpoint has "reasons": []
        assert a.reasons == ()


def test_assess_wind_field_is_the_load_adjusted_wind_level():
    # ASSUMPTION: Assessment.wind is the load-adjusted level
    # (SPEC 4: level = max(wind_level_after_load, rain_level, snow_level)).
    assert assess(40, 0, 0, 45_000).wind == SEV
    assert assess(47, 0, 0, 35_000).wind == NOTRAVEL
    assert assess(40, 0, 0, 35_000).wind == HIGH


def test_assess_reason_mentions_wind_speed_and_level_like_spec_example():
    # SPEC 4 example (non-binding "e.g."): "Wind 47 mph with 35,000 lb load -> No Travel"
    text = " | ".join(assess(47, 0, 0, 35_000).reasons).lower()
    assert "wind" in text
    assert "47" in text
    assert "no travel" in text


def test_assess_rain_and_snow_reasons_name_the_condition():
    assert any("rain" in r.lower() for r in assess(0, 0.6, 0, 0).reasons)
    assert any("snow" in r.lower() for r in assess(0, 0, 2.5, 0).reasons)


def test_assess_is_frozen():
    a = assess(0, 0, 0, 0)
    with pytest.raises(dataclasses.FrozenInstanceError):
        a.level = HIGH  # type: ignore[misc]
