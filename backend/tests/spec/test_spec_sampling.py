"""Black-box checks for planner.services.sampling, derived ONLY from SPEC 5 and 11.

Geometry used: straight/L-shaped polylines in (lon, lat). We almost always pass
``total_distance_mi`` so the mile scale is exact and independent of the haversine
earth radius the implementation picks (SPEC 5: polyline scaled to the provider distance).
"""
import math

import pytest

from planner.services.sampling import Checkpoint, owned_miles, sample_checkpoints


def meridian(lat0=32.0, lat1=33.0, lon=-97.0, n=11):
    """Straight north-south line; lon != lat so a lon/lat swap would be caught."""
    return [(lon, lat0 + (lat1 - lat0) * i / (n - 1)) for i in range(n)]


def expected_miles(total, interval):
    """Mile 0, every multiple of interval strictly below total, then the destination."""
    k_max = math.floor(total / interval + 1e-9)
    ks = [k * interval for k in range(k_max + 1) if k * interval < total - 1e-9]
    return ks + [total]


def miles(cps):
    return [c.mile for c in cps]


# --------------------------------------------------------------------------- #
# sample_checkpoints
# --------------------------------------------------------------------------- #
def test_first_checkpoint_is_mile_zero_at_origin_and_last_is_destination():
    coords = meridian()
    cps = sample_checkpoints(coords, 25, total_distance_mi=110)
    assert all(isinstance(c, Checkpoint) for c in cps)
    assert cps[0].index == 0
    assert cps[0].mile == pytest.approx(0.0)
    assert (cps[0].lon, cps[0].lat) == pytest.approx(coords[0])
    assert cps[-1].mile == pytest.approx(110.0)
    assert (cps[-1].lon, cps[-1].lat) == pytest.approx(coords[-1])


@pytest.mark.parametrize("interval", [10, 25, 50])
@pytest.mark.parametrize("total", [123.4, 100.0, 300.0, 101.0])
def test_miles_are_multiples_of_interval_plus_destination(total, interval):
    cps = sample_checkpoints(meridian(), interval, total_distance_mi=total)
    assert miles(cps) == pytest.approx(expected_miles(total, interval))


@pytest.mark.parametrize("interval", [10, 25, 50])
def test_spacing_equals_interval_except_last_gap(interval):
    cps = sample_checkpoints(meridian(), interval, total_distance_mi=237.0)
    ms = miles(cps)
    gaps = [b - a for a, b in zip(ms, ms[1:], strict=False)]
    assert gaps[:-1] == pytest.approx([interval] * (len(gaps) - 1))
    assert 0 < gaps[-1] <= interval + 1e-9


@pytest.mark.parametrize("total", [100.0, 100.001, 100.2, 99.9, 74.99, 125.0, 12.3])
@pytest.mark.parametrize("interval", [10, 25, 50])
def test_index_and_mile_strictly_increasing_and_destination_last(total, interval):
    coords = meridian()
    cps = sample_checkpoints(coords, interval, total_distance_mi=total)
    assert [c.index for c in cps] == list(range(len(cps)))
    ms = miles(cps)
    assert ms[0] == pytest.approx(0.0)
    strictly_up = all(b > a for a, b in zip(ms, ms[1:], strict=False))
    assert strictly_up, "miles must be strictly increasing (no duplicate destination)"
    assert ms[-1] == pytest.approx(total)
    assert (cps[-1].lon, cps[-1].lat) == pytest.approx(coords[-1])


def test_exact_multiple_does_not_duplicate_destination():
    cps = sample_checkpoints(meridian(), 25, total_distance_mi=100)
    assert miles(cps) == pytest.approx([0, 25, 50, 75, 100])


@pytest.mark.parametrize("total", [100.001, 100.2, 100.01])
def test_destination_added_even_when_remainder_is_tiny(total):
    cps = sample_checkpoints(meridian(), 25, total_distance_mi=total)
    assert miles(cps) == pytest.approx([0, 25, 50, 75, 100, total])
    assert cps[-1].lat == pytest.approx(33.0)


def test_remainder_just_below_interval_multiple():
    cps = sample_checkpoints(meridian(), 25, total_distance_mi=99.9)
    assert miles(cps) == pytest.approx([0, 25, 50, 75, 99.9])


@pytest.mark.parametrize("interval, total", [(25, 8.0), (50, 49.9), (10, 4.0), (50, 20.0)])
def test_route_shorter_than_interval_is_just_start_and_end(interval, total):
    coords = meridian()
    cps = sample_checkpoints(coords, interval, total_distance_mi=total)
    assert len(cps) == 2
    assert miles(cps) == pytest.approx([0.0, total])
    assert (cps[0].lon, cps[0].lat) == pytest.approx(coords[0])
    assert (cps[1].lon, cps[1].lat) == pytest.approx(coords[-1])


def test_route_exactly_one_interval_long_is_start_and_end():
    cps = sample_checkpoints(meridian(), 25, total_distance_mi=25)
    assert miles(cps) == pytest.approx([0.0, 25.0])


def test_two_point_polyline():
    cps = sample_checkpoints([(-97.0, 32.0), (-97.0, 33.0)], 25, total_distance_mi=100)
    assert miles(cps) == pytest.approx([0, 25, 50, 75, 100])
    assert [c.lat for c in cps] == pytest.approx([32.0, 32.25, 32.5, 32.75, 33.0], abs=1e-3)
    assert [c.lon for c in cps] == pytest.approx([-97.0] * 5, abs=1e-6)


def test_checkpoints_lie_along_the_polyline_with_lon_lat_order():
    cps = sample_checkpoints(meridian(), 25, total_distance_mi=100)
    for c in cps:
        assert c.lon == pytest.approx(-97.0, abs=1e-6)  # (lon, lat) input order respected
        assert c.lat == pytest.approx(32.0 + c.mile / 100.0, abs=1e-3)


def test_checkpoints_follow_the_path_not_the_chord():
    # L-shaped: north 1 deg, then east 1 deg. Legs are ~equal in length, so with total=140
    # the corner is at ~mile 70.
    coords = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0)]
    cps = sample_checkpoints(coords, 35, total_distance_mi=140)
    assert miles(cps) == pytest.approx([0, 35, 70, 105, 140])
    assert (cps[1].lon, cps[1].lat) == pytest.approx((0.0, 0.5), abs=0.01)
    assert (cps[2].lon, cps[2].lat) == pytest.approx((0.0, 1.0), abs=0.01)
    assert (cps[3].lon, cps[3].lat) == pytest.approx((0.5, 1.0), abs=0.01)
    assert (cps[4].lon, cps[4].lat) == pytest.approx((1.0, 1.0), abs=1e-6)


def test_total_distance_scales_the_mile_axis():
    coords = meridian()
    short = sample_checkpoints(coords, 50, total_distance_mi=50)
    long_ = sample_checkpoints(coords, 50, total_distance_mi=200)
    assert miles(short) == pytest.approx([0, 50])
    assert miles(long_) == pytest.approx([0, 50, 100, 150, 200])
    # destination is the same physical point; mile 50 of the long route is a quarter of the way
    assert (short[-1].lon, short[-1].lat) == pytest.approx((long_[-1].lon, long_[-1].lat))
    assert long_[1].lat == pytest.approx(32.25, abs=1e-3)
    assert short[-1].lat == pytest.approx(33.0)


def test_without_total_distance_uses_haversine_length():
    # 1 degree of latitude is ~69.1 mi regardless of the exact earth radius used.
    cps = sample_checkpoints(meridian(), 25)
    ms = miles(cps)
    assert ms[:3] == pytest.approx([0, 25, 50])
    assert ms[-1] == pytest.approx(69.1, abs=0.4)
    assert len(cps) == 4


def test_repeated_vertices_do_not_break_sampling():
    # Robustness (not spelled out in SPEC): zero-length segments are common in provider polylines.
    coords = [(-97.0, 32.0), (-97.0, 32.0), (-97.0, 32.5), (-97.0, 32.5), (-97.0, 33.0)]
    cps = sample_checkpoints(coords, 25, total_distance_mi=100)
    assert miles(cps) == pytest.approx([0, 25, 50, 75, 100])
    assert [c.lat for c in cps] == pytest.approx([32.0, 32.25, 32.5, 32.75, 33.0], abs=1e-3)


# --------------------------------------------------------------------------- #
# owned_miles
# --------------------------------------------------------------------------- #
def test_owned_miles_even_spacing_endpoints_get_half_gaps():
    assert owned_miles([0, 25, 50, 75, 100], 100) == pytest.approx([12.5, 25, 25, 25, 12.5])


def test_owned_miles_uneven_spacing():
    # gaps 25, 25, 10 -> [25/2, (25+25)/2, (25+10)/2, 10/2]
    assert owned_miles([0, 25, 50, 60], 60) == pytest.approx([12.5, 25, 17.5, 5])


def test_owned_miles_two_checkpoints():
    assert owned_miles([0, 10], 10) == pytest.approx([5, 5])


def test_owned_miles_tiny_final_gap():
    got = owned_miles([0, 25, 50, 75, 100, 100.2], 100.2)
    assert got == pytest.approx([12.5, 25, 25, 25, 12.6, 0.1])
    assert sum(got) == pytest.approx(100.2)


@pytest.mark.parametrize("interval", [10, 25, 50])
@pytest.mark.parametrize("total", [8.0, 25.0, 100.0, 123.4, 795.2])
def test_owned_miles_sum_to_total_for_sampled_routes(total, interval):
    cps = sample_checkpoints(meridian(), interval, total_distance_mi=total)
    owned = owned_miles(miles(cps), total)
    assert len(owned) == len(cps)
    assert all(o >= 0 for o in owned)
    assert sum(owned) == pytest.approx(total)
    # endpoints own exactly half of the adjacent gap
    ms = miles(cps)
    assert owned[0] == pytest.approx((ms[1] - ms[0]) / 2)
    assert owned[-1] == pytest.approx((ms[-1] - ms[-2]) / 2)
