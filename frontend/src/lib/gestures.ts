export interface ScreenPoint { x: number; y: number }

export const LONG_PRESS_MS = 500;
/** Radius of a 44 px finger target. */
export const TOUCH_RADIUS = 22;

const squaredDistance = (a: ScreenPoint, b: ScreenPoint) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function withinPressSlop(start: ScreenPoint, current: ScreenPoint): boolean {
  return squaredDistance(start, current) <= 8 ** 2;
}

export function nearestPointIndex(at: ScreenPoint, points: readonly ScreenPoint[]): number {
  let nearest = -1;
  let distance = Infinity;
  points.forEach((point, index) => {
    const next = squaredDistance(at, point);
    if (next < distance) {
      nearest = index;
      distance = next;
    }
  });
  return nearest;
}

/** Distance in CSS pixels, including degenerate segments and single-point lines. */
export function distanceToLine(at: ScreenPoint, line: readonly ScreenPoint[]): number {
  if (!line.length) return Infinity;
  let best = squaredDistance(at, line[0]);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const length = squaredDistance(a, b);
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / length));
    best = Math.min(best, squaredDistance(at, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }));
  }
  return Math.sqrt(best);
}

export function hapticHint(): void {
  if (typeof navigator.vibrate === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    navigator.vibrate(8);
  }
}
