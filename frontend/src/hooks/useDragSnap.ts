import { hapticHint } from "../lib/gestures";
import { AXIS_LOCK_PX, dampOverscroll, lockAxis } from "./useSwipe";

/** Finger speed, in px/ms, that counts as a flick. A flick moves exactly one snap. */
export const FLICK_PX_PER_MS = 0.6;

/** Samples older than this do not contribute to the release velocity. */
export const VELOCITY_WINDOW_MS = 100;

export type Snap = "collapsed" | "half" | "expanded";

/** Sheet order from top to bottom of the screen: translateY grows as the sheet collapses. */
export const SNAP_TOP_TO_BOTTOM: readonly Snap[] = ["expanded", "half", "collapsed"];

export interface SnapPoints {
  /** translateY while the layout height is frozen at the expanded snap. 0 is fully expanded. */
  expanded: number;
  half: number;
  collapsed: number;
}

export interface VelocitySample {
  y: number;
  t: number;
}

/**
 * Travel from the expanded layout box to each snap. The sheet is laid out at the expanded
 * height once per gesture and only `translateY` moves after that, so later frames do not reflow.
 */
export function snapTravel(expandedH: number, halfH: number, collapsedH: number): SnapPoints | null {
  if (!(expandedH > halfH && halfH > collapsedH && collapsedH > 0)) return null;
  return {
    expanded: 0,
    half: expandedH - halfH,
    collapsed: expandedH - collapsedH,
  };
}

/**
 * Pull past either end. The finger can keep going; the sheet lags and never quite reaches
 * `dimension` px beyond the end.
 */
export function rubberBand(value: number, min: number, max: number, dimension = 120): number {
  if (!(max >= min)) return value;
  if (value < min) return min - dampOverscroll(min - value, dimension);
  if (value > max) return max + dampOverscroll(value - max, dimension);
  return value;
}

/**
 * Nearest snap to `position`. An exact tie keeps the earlier snap (more expanded) unless `bias`
 * breaks it: +1 toward collapsed, -1 toward expanded.
 */
export function nearestSnap(points: SnapPoints, position: number, bias: -1 | 0 | 1 = 0): Snap {
  let best: Snap = "expanded";
  let bestDist = Infinity;
  for (const snap of SNAP_TOP_TO_BOTTOM) {
    const dist = Math.abs(points[snap] - position);
    if (dist < bestDist - 0.01) {
      best = snap;
      bestDist = dist;
    } else if (bias !== 0 && Math.abs(dist - bestDist) <= 0.01) {
      const better =
        bias > 0
          ? SNAP_TOP_TO_BOTTOM.indexOf(snap) > SNAP_TOP_TO_BOTTOM.indexOf(best)
          : SNAP_TOP_TO_BOTTOM.indexOf(snap) < SNAP_TOP_TO_BOTTOM.indexOf(best);
      if (better) best = snap;
    }
  }
  return best;
}

/**
 * Where a release lands. Below the flick speed, the closest snap wins (a slow drag can cross
 * two snaps). A flick steps exactly one snap from that closest snap, so a fast swipe never
 * skips a stop the finger has not already reached.
 */
export function settleSnap(points: SnapPoints, position: number, velocityY: number): Snap {
  const bias: -1 | 0 | 1 = velocityY > 0 ? 1 : velocityY < 0 ? -1 : 0;
  if (Math.abs(velocityY) < FLICK_PX_PER_MS) return nearestSnap(points, position, bias);
  const base = nearestSnap(points, position, 0);
  const index = SNAP_TOP_TO_BOTTOM.indexOf(base) + Math.sign(velocityY);
  return SNAP_TOP_TO_BOTTOM[Math.min(SNAP_TOP_TO_BOTTOM.length - 1, Math.max(0, index))];
}

/** Release speed from recent samples. Positive means the finger moved down (sheet collapses). */
export function velocityFromSamples(samples: readonly VelocitySample[], windowMs = VELOCITY_WINDOW_MS): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let firstIndex = samples.length - 1;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs && firstIndex !== samples.length - 1) break;
    firstIndex = i;
  }
  const first = samples[firstIndex];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.y - first.y) / dt;
}

const ORDER: Snap[] = ["collapsed", "half", "expanded"];

function shiftSnap(current: Snap, direction: 1 | -1): Snap {
  return ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(current) + direction))];
}

function phone(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function tryCapture(target: EventTarget | null, pointerId: number): void {
  if (!(target instanceof HTMLElement) || typeof target.setPointerCapture !== "function") return;
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Untrusted events and jsdom have no active pointer.
  }
}

function readTranslate(panel: HTMLElement): number {
  const match = /translateY\(([-\d.]+)px\)/.exec(panel.style.transform);
  return match ? Number(match[1]) : 0;
}

interface Session {
  pointerId: number;
  startX: number;
  startY: number;
  startScroll: number;
  source: "handle" | "body";
  claimed: boolean;
  fallback: boolean;
  originY: number;
  originSnap: Snap;
  points: SnapPoints | null;
  samples: VelocitySample[];
}

const NEXT: Record<Snap, Snap> = {
  collapsed: "half",
  half: "expanded",
  expanded: "collapsed",
};

/**
 * Phone bottom sheet: the finger drags `translateY` on the panel (one layout freeze at claim,
 * no per-frame reflow). Release snaps by position, or by one snap when the finger flicks.
 * The scroll body keeps native scrolling; pulling down at scrollTop 0 drags the sheet.
 * Call it from an effect. The handle button's click cycles snaps unless the gesture swallowed it.
 */
export function attachSheetDrag(
  panel: HTMLElement,
  scroll: HTMLDivElement,
  snapRef: { current: Snap },
  setSnap: (next: Snap) => void,
): () => void {
  const sessionRef: { current: Session | null } = { current: null };
  const swallowRef = { current: false };
  const generation = { current: 0 };
  const timer = { current: 0 };
  const swallowTimer = { current: 0 };
  const swallowStop: { current: ((event: Event) => void) | null } = { current: null };
  const handle = panel.querySelector<HTMLButtonElement>(".sheet-toggle");

  function clearBodySwallow(): void {
    window.clearTimeout(swallowTimer.current);
    if (!swallowStop.current) return;
    document.removeEventListener("click", swallowStop.current, true);
    swallowStop.current = null;
  }

  /** The click after a drag on the sheet body would select whatever control is under the finger. */
  function armBodySwallow(): void {
    clearBodySwallow();
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      clearBodySwallow();
    };
    swallowStop.current = stop;
    document.addEventListener("click", stop, true);
    swallowTimer.current = window.setTimeout(clearBodySwallow, 400);
  }

  const onBodyDown = (event: PointerEvent) => begin(event, "body", scroll);
  const onBodyMove = (event: PointerEvent) => move(event, scroll);
  const onBodyUp = (event: PointerEvent) => end(event, false);
  const onBodyCancel = (event: PointerEvent) => end(event, true);
  const onHandleDown = (event: PointerEvent) => begin(event, "handle", handle);
  const onHandleMove = (event: PointerEvent) => move(event, handle);
  const onHandleUp = (event: PointerEvent) => end(event, false);
  const onHandleCancel = (event: PointerEvent) => end(event, true);
  const onHandleClick = (event: MouseEvent) => {
    if (swallowRef.current) {
      swallowRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setSnap(NEXT[snapRef.current]);
  };

  // Chromium picks the pan at touchstart, so the hit target's touch-action has to be right
  // before pointerdown. data-sheet-pull switches descendants to pan-down (see sheet-gestures.css):
  // a finger moving up still scrolls the body, a finger moving down drags the sheet.
  const phoneMedia = window.matchMedia("(max-width: 767px)");
  const syncBodyTouch = () => {
    // A touch-action change mid-gesture makes Chromium fire pointercancel.
    if (sessionRef.current) return;
    if (phoneMedia.matches && scroll.scrollTop <= 1) panel.dataset.sheetPull = "true";
    else delete panel.dataset.sheetPull;
  };
  scroll.addEventListener("scroll", syncBodyTouch, { passive: true });
  phoneMedia.addEventListener("change", syncBodyTouch);
  syncBodyTouch();

  scroll.addEventListener("pointerdown", onBodyDown);
  scroll.addEventListener("pointermove", onBodyMove);
  scroll.addEventListener("pointerup", onBodyUp);
  scroll.addEventListener("pointercancel", onBodyCancel);
  handle?.addEventListener("pointerdown", onHandleDown);
  handle?.addEventListener("pointermove", onHandleMove);
  handle?.addEventListener("pointerup", onHandleUp);
  handle?.addEventListener("pointercancel", onHandleCancel);
  handle?.addEventListener("click", onHandleClick);

  function begin(event: PointerEvent, source: "handle" | "body", captureTarget: HTMLElement | null): void {
    if (!phone() || !event.isPrimary || event.button !== 0) return;
    if (panel.dataset.dragging === "settle") return;
    swallowRef.current = false;
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScroll: scroll.scrollTop,
      source,
      claimed: false,
      fallback: false,
      originY: 0,
      originSnap: snapRef.current,
      points: null,
      samples: [{ y: event.clientY, t: performance.now() }],
    };
    // The handle is the grabber: capture immediately so a drag that leaves the bar still tracks.
    // The body waits until the axis is known, otherwise it would block route swipes and scrolling.
    if (source === "handle") tryCapture(captureTarget, event.pointerId);
  }

  function releaseBodyTouch(source: Session["source"] | undefined): void {
    if (source === "body") syncBodyTouch();
  }

  function note(session: Session, clientY: number): void {
    session.samples.push({ y: clientY, t: performance.now() });
    if (session.samples.length > 8) session.samples.shift();
  }

  /** Freeze the panel at the expanded height and remember the translate that keeps it visually put. */
  function freeze(session: Session): boolean {
    const grabber = panel.querySelector<HTMLElement>(".sheet-handle");
    if (!grabber) return false;
    if (panel.dataset.dragging === "true" && session.points) return true;

    const collapsedH = grabber.getBoundingClientRect().height;
    const currentH = panel.getBoundingClientRect().height;
    const previous = panel.style.height;
    panel.style.height = "62dvh";
    const expandedH = panel.getBoundingClientRect().height;
    panel.style.height = "36dvh";
    const halfH = panel.getBoundingClientRect().height;
    const points = snapTravel(expandedH, halfH, collapsedH);
    if (!points) {
      panel.style.height = previous;
      return false;
    }
    const originY = Math.min(points.collapsed, Math.max(0, expandedH - currentH));
    panel.style.height = `${expandedH}px`;
    panel.dataset.dragging = "true";
    panel.style.willChange = "transform";
    panel.style.transform = `translateY(${originY}px)`;
    session.points = points;
    session.originY = originY;
    return true;
  }

  function follow(session: Session, fingerDy: number): void {
    const points = session.points;
    if (!panel || !points) return;
    const y = rubberBand(session.originY + fingerDy, points.expanded, points.collapsed);
    panel.style.transform = `translateY(${y}px)`;
  }

  function move(event: PointerEvent, captureTarget: HTMLElement | null): void {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    note(session, event.clientY);
    const dy = event.clientY - session.startY;
    const dx = event.clientX - session.startX;

    if (!session.claimed) {
      if (session.source === "handle") {
        if (Math.abs(dy) < AXIS_LOCK_PX && Math.abs(dx) < AXIS_LOCK_PX) return;
      } else {
        const axis = lockAxis(dx, dy);
        if (!axis) return;
        // Horizontal belongs to the route cards. Upward, or any drag while the body is
        // scrolled, belongs to native scrolling.
        const scrollTop = scroll.scrollTop;
        if (axis !== "y" || dy < 0 || session.startScroll > 1 || scrollTop > 1) {
          releaseBodyTouch(session.source);
          sessionRef.current = null;
          return;
        }
        tryCapture(captureTarget, event.pointerId);
      }
      session.claimed = true;
      if (!freeze(session)) session.fallback = true;
    }

    if (session.fallback || !session.points) return;
    if (event.cancelable) event.preventDefault();
    follow(session, dy);
  }

  function commit(gen: number, next: Snap): void {
    if (gen !== generation.current) return;
    generation.current += 1;
    window.clearTimeout(timer.current);
    // Set the snap attribute before dropping the inline height so the stylesheet and the
    // visual position agree in the same frame. React's state update repeats the attribute.
    panel.dataset.snap = next;
    delete panel.dataset.dragging;
    panel.style.height = "";
    panel.style.transform = "";
    panel.style.willChange = "";
    if (next !== snapRef.current) {
      hapticHint();
      setSnap(next);
    }
  }

  function finish(next: Snap, fromY: number, points: SnapPoints | null): void {
    const gen = generation.current;
    if (!panel || !points || reducedMotion()) {
      commit(gen, next);
      return;
    }
    const target = points[next];
    if (Math.abs(target - fromY) < 0.5) {
      commit(gen, next);
      return;
    }
    panel.dataset.dragging = "settle";
    // The transition is armed by the attribute; apply the target on the next frame so it runs.
    requestAnimationFrame(() => {
      if (gen !== generation.current) return;
      panel.style.transform = `translateY(${target}px)`;
    });
    const onEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "transform" || event.target !== panel) return;
      panel.removeEventListener("transitionend", onEnd);
      commit(gen, next);
    };
    panel.addEventListener("transitionend", onEnd);
    timer.current = window.setTimeout(() => {
      panel.removeEventListener("transitionend", onEnd);
      commit(gen, next);
    }, 400);
  }

  function end(event: PointerEvent, cancel: boolean): void {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    sessionRef.current = null;
    releaseBodyTouch(session.source);
    if (!session.claimed) return;
    if (!cancel) {
      if (session.source === "handle") swallowRef.current = true;
      else armBodySwallow();
    }
    if (cancel) {
      finish(session.originSnap, readTranslate(panel), session.points);
      return;
    }
    if (session.fallback || !session.points) {
      const direction: 1 | -1 = event.clientY < session.startY ? 1 : -1;
      commit(generation.current, shiftSnap(snapRef.current, direction));
      return;
    }
    const velocity = velocityFromSamples(session.samples);
    const position = readTranslate(panel);
    finish(settleSnap(session.points, position, velocity), position, session.points);
  }

  return () => {
    generation.current += 1;
    window.clearTimeout(timer.current);
    clearBodySwallow();
    delete panel.dataset.sheetPull;
    scroll.removeEventListener("scroll", syncBodyTouch);
    phoneMedia.removeEventListener("change", syncBodyTouch);
    scroll.removeEventListener("pointerdown", onBodyDown);
    scroll.removeEventListener("pointermove", onBodyMove);
    scroll.removeEventListener("pointerup", onBodyUp);
    scroll.removeEventListener("pointercancel", onBodyCancel);
    handle?.removeEventListener("pointerdown", onHandleDown);
    handle?.removeEventListener("pointermove", onHandleMove);
    handle?.removeEventListener("pointerup", onHandleUp);
    handle?.removeEventListener("pointercancel", onHandleCancel);
    handle?.removeEventListener("click", onHandleClick);
  };
}
