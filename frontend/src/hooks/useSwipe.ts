import { useEffect, useRef, type RefObject } from "react";

/** Movement, in px, before a gesture picks an axis. Shared with the sheet drag. */
export const AXIS_LOCK_PX = 10;

/** Forecast hour steps once per this many horizontal px (~one thumb-width of travel). */
export const HOUR_SWIPE_PX = 24;

/** Horizontal travel that selects the neighbouring route. */
export const ROUTE_SWIPE_PX = 36;

export type Axis = "x" | "y";

/**
 * Decide the gesture axis after `threshold` px. A tie (a 45° drag) stays horizontal so a
 * vertical scroller — `touch-action: pan-y` — keeps the scroll and the sheet does not steal it.
 * Returns null until the finger has actually moved.
 */
export function lockAxis(dx: number, dy: number, threshold = AXIS_LOCK_PX): Axis | null {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  return Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
}

/**
 * Finger moving left (negative dx) advances the forecast, the same direction as paging forward.
 * Partial steps are dropped so a 23 px nudge does not change the hour.
 */
export function hourDeltaFromSwipe(dx: number, pxPerStep = HOUR_SWIPE_PX): number {
  if (!(pxPerStep > 0) || !Number.isFinite(dx)) return 0;
  const steps = Math.trunc(-dx / pxPerStep);
  return steps === 0 ? 0 : steps;
}

/** +1 selects the next route (swipe left), -1 the previous (swipe right). */
export function routeStepFromSwipe(dx: number, min = ROUTE_SWIPE_PX): -1 | 0 | 1 {
  if (dx <= -min) return 1;
  if (dx >= min) return -1;
  return 0;
}

/** Index of a uniform row hit at `clientX`. The right edge stays on the last cell. */
export function indexAt(clientX: number, left: number, width: number, count: number): number {
  if (count <= 1 || !(width > 0) || !Number.isFinite(clientX)) return 0;
  const ratio = (clientX - left) / width;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(ratio * count)));
}

/**
 * Short slide while a card is swiped: 1:1 up to `limit`, then rubber-band so the card
 * never flies off the row. `damp` is the same resistance the sheet uses past its snaps.
 */
export function slideFeedback(dx: number, limit = 40): number {
  if (!Number.isFinite(dx) || dx === 0) return 0;
  const capped = Math.max(-limit * 4, Math.min(limit * 4, dx));
  const magnitude = Math.abs(capped);
  if (magnitude <= limit) return capped;
  const extra = dampOverscroll(magnitude - limit, 36);
  return Math.sign(capped) * (limit + extra);
}

/** iOS-style resistance: visible overscroll grows slower than the finger and stays under `dimension`. */
export function dampOverscroll(distance: number, dimension = 120, constant = 0.55): number {
  const excess = Math.abs(distance);
  if (!(dimension > 0) || excess === 0 || !Number.isFinite(excess)) return 0;
  return (excess * dimension * constant) / (dimension + constant * excess);
}

export interface AxisPoint {
  dx: number;
  dy: number;
  /** Delta along the claimed axis. */
  delta: number;
  event: PointerEvent;
}

export interface AxisClaimOptions {
  /** When false the listeners ignore new gestures (route swipe is phone-only). */
  enabled?: boolean;
  claim: Axis;
  /** Return false to leave the pointer to a control inside the surface (the forecast thumb). */
  allow?: (event: PointerEvent) => boolean;
  /** Fired once, on the move that locks the claimed axis. */
  onClaim?: (event: PointerEvent) => void;
  onMove?: (point: AxisPoint) => void;
  onEnd?: (point: AxisPoint) => void;
  onCancel?: () => void;
  /**
   * Swallow the click that follows a gesture whose claimed-axis travel reached this distance.
   * A shorter press still activates the button underneath. Omit to never swallow.
   */
  swallowAt?: number;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  axis: Axis | null;
  /** Last pointermove. Some touch paths report the start point again on pointerup. */
  lastX: number;
  lastY: number;
}

function tryCapture(target: EventTarget | null, pointerId: number): void {
  if (!(target instanceof HTMLElement) || typeof target.setPointerCapture !== "function") return;
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // jsdom and untrusted events have no active pointer. Tracking pointerId is enough there.
  }
}

function tryRelease(target: EventTarget | null, pointerId: number): void {
  if (!(target instanceof HTMLElement) || typeof target.releasePointerCapture !== "function") return;
  try {
    if (!target.hasPointerCapture?.(pointerId)) return;
    target.releasePointerCapture(pointerId);
  } catch {
    // The pointer is already gone.
  }
}

/**
 * Pointer-events gesture that claims one axis after {@link AXIS_LOCK_PX} and leaves the other
 * to the browser. One path for touch, pen and mouse. `touch-action` on the element decides
 * which pans the browser is allowed to start before this runs.
 */
export function useAxisClaim<T extends HTMLElement>(options: AxisClaimOptions): RefObject<T | null> {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const ref = useRef<T>(null);
  const gesture = useRef<Gesture | null>(null);
  const swallowTimer = useRef(0);
  const swallowStop = useRef<((event: Event) => void) | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const clearSwallow = () => {
      window.clearTimeout(swallowTimer.current);
      if (swallowStop.current) {
        document.removeEventListener("click", swallowStop.current, true);
        swallowStop.current = null;
      }
    };

    const armSwallow = () => {
      clearSwallow();
      const stop = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSwallow();
      };
      swallowStop.current = stop;
      document.addEventListener("click", stop, true);
      // A touch drag does not always synthesize a click. Don't eat a later tap.
      swallowTimer.current = window.setTimeout(clearSwallow, 400);
    };

    const pointOf = (event: PointerEvent, current: Gesture, x = event.clientX, y = event.clientY): AxisPoint => {
      const dx = x - current.x;
      const dy = y - current.y;
      return { dx, dy, delta: optionsRef.current.claim === "x" ? dx : dy, event };
    };

    /** pointerup from a touch can repeat the down point. The last move is the release position. */
    const releasePoint = (event: PointerEvent, current: Gesture): { x: number; y: number } => {
      const reportedStart =
        Math.abs(event.clientX - current.x) < 1 && Math.abs(event.clientY - current.y) < 1;
      const moved =
        Math.abs(current.lastX - current.x) >= AXIS_LOCK_PX || Math.abs(current.lastY - current.y) >= AXIS_LOCK_PX;
      const atOrigin = event.clientX === 0 && event.clientY === 0 && (current.lastX !== 0 || current.lastY !== 0);
      if ((reportedStart && moved) || atOrigin) return { x: current.lastX, y: current.lastY };
      return { x: event.clientX, y: event.clientY };
    };

    const onDown = (event: PointerEvent) => {
      const opts = optionsRef.current;
      if (opts.enabled === false || !event.isPrimary || event.button !== 0) return;
      if (opts.allow && !opts.allow(event)) return;
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        axis: null,
        lastX: event.clientX,
        lastY: event.clientY,
      };
    };

    const onMove = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.id) return;
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      const point = pointOf(event, current);
      if (!current.axis) {
        const axis = lockAxis(point.dx, point.dy);
        if (!axis) return;
        current.axis = axis;
        if (axis !== optionsRef.current.claim) {
          gesture.current = null;
          return;
        }
        tryCapture(node, event.pointerId);
        optionsRef.current.onClaim?.(event);
      }
      if (current.axis !== optionsRef.current.claim) return;
      if (event.cancelable) event.preventDefault();
      optionsRef.current.onMove?.(point);
    };

    const finish = (event: PointerEvent, cancel: boolean) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.id) return;
      gesture.current = null;
      tryRelease(node, event.pointerId);
      // A press that never locked an axis is a tap: the control's click stands.
      if (!current.axis) return;
      if (cancel || current.axis !== optionsRef.current.claim) {
        optionsRef.current.onCancel?.();
        return;
      }
      const at = releasePoint(event, current);
      const point = pointOf(event, current, at.x, at.y);
      const swallowAt = optionsRef.current.swallowAt;
      if (swallowAt != null && Math.abs(point.delta) >= swallowAt) armSwallow();
      optionsRef.current.onEnd?.(point);
    };

    const onUp = (event: PointerEvent) => finish(event, false);
    const onCancel = (event: PointerEvent) => finish(event, true);

    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onCancel);
    return () => {
      clearSwallow();
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  return ref;
}
