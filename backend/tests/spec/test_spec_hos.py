"""Black-box checks for planner.services.hos, derived ONLY from SPEC 5 and 11.

SPEC 5: 30-min break after 8 h cumulative driving since the last break/rest;
10-h off-duty after 11 h driving; ETA = departure + elapsed_with_breaks(drive_seconds).

OPEN POINTS in the SPEC (tests marked ASSUMPTION / avoided):
  * Whether a break/rest is charged when driving ends EXACTLY at 8 h / 11 h. We never pin
    that point, except through the self-consistency check against break_schedule().
  * How the 8-h counter behaves after a 10-h rest. ASSUMPTION: the 10-h off-duty period also
    resets the "since last break" counter (real FMCSA: it satisfies the 30-min break rule).
  * Break.type strings other than the SPEC 7 example "break_30m" are not pinned.
"""
import pytest

from planner.services.hos import break_schedule, elapsed_with_breaks

H = 3600
BREAK = 30 * 60
REST = 10 * H


def test_zero_drive_is_zero_elapsed():
    assert elapsed_with_breaks(0) == 0
    assert break_schedule(0) == []


@pytest.mark.parametrize("drive", [1, 600, 3 * H, 7 * H, 8 * H - 1])
def test_no_breaks_under_8_hours(drive):
    assert elapsed_with_breaks(drive) == pytest.approx(drive)
    assert break_schedule(drive) == []


def test_30_min_break_once_8_hours_exceeded():
    assert elapsed_with_breaks(8 * H + 1) == pytest.approx(8 * H + 1 + BREAK)
    assert elapsed_with_breaks(9 * H) == pytest.approx(9 * H + BREAK)
    assert elapsed_with_breaks(10 * H) == pytest.approx(10 * H + BREAK)
    assert elapsed_with_breaks(11 * H - 1) == pytest.approx(11 * H - 1 + BREAK)


def test_break_schedule_single_break_at_8_hours():
    sched = break_schedule(9 * H)
    assert len(sched) == 1
    b = sched[0]
    assert b.drive_seconds_at == pytest.approx(8 * H)
    assert b.duration_s == pytest.approx(BREAK)
    assert b.type == "break_30m"  # SPEC 7 example value


def test_10_hour_rest_after_11_hours_driving():
    # 8 h drive, 30 min break, 3 h drive (=11 h total), 10 h rest, 1 h drive
    assert elapsed_with_breaks(11 * H + 1) == pytest.approx(11 * H + 1 + BREAK + REST)
    assert elapsed_with_breaks(12 * H) == pytest.approx(12 * H + BREAK + REST)


def test_break_schedule_for_12_hours_has_break_then_rest():
    sched = break_schedule(12 * H)
    assert [round(b.drive_seconds_at) for b in sched] == [8 * H, 11 * H]
    assert [round(b.duration_s) for b in sched] == [BREAK, REST]


def test_rest_not_charged_before_11_hours_driving():
    assert elapsed_with_breaks(10.99 * H) == pytest.approx(10.99 * H + BREAK)


def test_after_rest_counters_reset_assumption():
    # ASSUMPTION: a 10-h rest also resets the 8-h counter.
    # 18 h = 8 | break | 3 | REST | 7 h (< 8 h since rest -> no second break)
    assert elapsed_with_breaks(18 * H) == pytest.approx(18 * H + BREAK + REST)
    # 19 h + 1 s = ... | REST | 8 h + 1 s -> a second 30-min break
    assert elapsed_with_breaks(19 * H + 1) == pytest.approx(19 * H + 1 + 2 * BREAK + REST)


def test_24_hours_of_driving_assumption():
    # ASSUMPTION as above. 8 | b | 3 | R | 8 | b | 3 | R | 2  -> 2 breaks, 2 rests.
    assert elapsed_with_breaks(24 * H) == pytest.approx(24 * H + 2 * BREAK + 2 * REST)
    sched = break_schedule(24 * H)
    assert [round(b.duration_s) for b in sched] == [BREAK, REST, BREAK, REST]
    assert [round(b.drive_seconds_at) for b in sched] == [8 * H, 11 * H, 19 * H, 22 * H]


@pytest.mark.parametrize("drive", [0, 1, 3600, 8 * H + 1, 11 * H + 1, 30 * H, 100 * H])
def test_disabled_is_identity(drive):
    assert elapsed_with_breaks(drive, enabled=False) == pytest.approx(drive)
    assert elapsed_with_breaks(drive, False) == pytest.approx(drive)


def test_enabled_is_the_default():
    assert elapsed_with_breaks(9 * H) == elapsed_with_breaks(9 * H, enabled=True)
    assert elapsed_with_breaks(9 * H) > 9 * H


def _sweep():
    points = {0, 1}
    t = 0
    while t <= 40 * H:
        points.add(t)
        t += 900
    for edge in (8 * H, 11 * H, 19 * H, 22 * H, 30 * H):
        points.update({edge - 1, edge, edge + 1})
    return sorted(points)


def test_elapsed_is_monotonic_and_never_less_than_drive_time():
    prev_t, prev_e = None, None
    for t in _sweep():
        e = elapsed_with_breaks(t)
        assert e >= t - 1e-6
        if prev_e is not None:
            assert e >= prev_e - 1e-6, f"elapsed decreased between {prev_t} and {t}"
            assert e - prev_e >= (t - prev_t) - 1e-6, "breaks must never remove time"
        prev_t, prev_e = t, e


def test_elapsed_matches_drive_plus_scheduled_breaks():
    # Self-consistency; holds whichever way the exact-boundary question is resolved.
    for t in _sweep():
        sched = break_schedule(t)
        assert elapsed_with_breaks(t) == pytest.approx(t + sum(b.duration_s for b in sched))


def test_break_schedule_is_ordered_and_uses_the_two_durations():
    sched = break_schedule(40 * H)
    ats = [b.drive_seconds_at for b in sched]
    assert ats == sorted(ats)
    assert all(0 <= a <= 40 * H for a in ats)
    assert {round(b.duration_s) for b in sched} <= {BREAK, REST}
    # 40 h of driving must include at least three 10-h rests (every 11 h of driving)
    assert sum(1 for b in sched if round(b.duration_s) == REST) >= 3
