from dataclasses import dataclass

from .risk import nonnegative

BREAK_AFTER_S = 8 * 3600
CYCLE_S = 11 * 3600
REST_S = 10 * 3600
BREAK_S = 30 * 60


@dataclass(frozen=True)
class Break:
    type: str
    drive_seconds_at: float
    duration_s: float


def break_schedule(total_drive_seconds: float) -> list[Break]:
    """No break/rest is required after reaching the final destination."""
    nonnegative(total_drive_seconds)
    result = []
    cycle = 0
    while cycle * CYCLE_S + BREAK_AFTER_S < total_drive_seconds:
        result.append(Break("break_30m", cycle * CYCLE_S + BREAK_AFTER_S, BREAK_S))
        rest_at = (cycle + 1) * CYCLE_S
        if rest_at < total_drive_seconds:
            result.append(Break("rest_10h", rest_at, REST_S))
        cycle += 1
    return result


def elapsed_with_breaks(drive_seconds: float, enabled: bool = True) -> float:
    nonnegative(drive_seconds)
    rest_seconds = sum(b.duration_s for b in break_schedule(drive_seconds)) if enabled else 0
    return drive_seconds + rest_seconds
