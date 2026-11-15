import { useRef, useState, type PointerEvent, type ReactNode } from "react";

type Snap = "collapsed" | "half" | "expanded";

const ORDER: Snap[] = ["collapsed", "half", "expanded"];

const NEXT: Record<Snap, Snap> = {
  collapsed: "half",
  half: "expanded",
  expanded: "collapsed",
};

const ACTION: Record<Snap, string> = {
  collapsed: "Show the trip panel halfway",
  half: "Expand the trip panel",
  expanded: "Collapse the trip panel",
};

/** Finger travel, in px, past which a press on the handle counts as a drag instead of a tap. */
const DRAG_PX = 10;

function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function initialSnap(): Snap {
  return isPhone() ? "expanded" : "half";
}

interface TripSheetProps {
  /** Short line shown beside the grab bar on phones, e.g. "Dallas → Denver". */
  title: string;
  /** Changes when new results arrive; phones then settle on the half snap so the map is visible. */
  settleKey?: string | null;
  children: ReactNode;
}

/** Floating card on desktop and tablet; a bottom sheet with three snaps (tap, swipe or key) on phones. */
export function TripSheet({ title, settleKey, children }: TripSheetProps) {
  const [snap, setSnap] = useState<Snap>(initialSnap);
  const [seenKey, setSeenKey] = useState(settleKey ?? null);
  const press = useRef<{ y: number; dragged: boolean } | null>(null);
  const swallowClick = useRef(false);
  if ((settleKey ?? null) !== seenKey) {
    setSeenKey(settleKey ?? null);
    if (settleKey && isPhone()) setSnap("half");
  }

  function shift(direction: 1 | -1) {
    setSnap((current) => ORDER[Math.min(2, Math.max(0, ORDER.indexOf(current) + direction))]);
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    press.current = { y: event.clientY, dragged: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    if (current && Math.abs(event.clientY - current.y) > DRAG_PX) current.dragged = true;
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    press.current = null;
    if (!current?.dragged) return;
    // Swipe up grows the sheet, swipe down shrinks it. The click that follows is swallowed below.
    swallowClick.current = true;
    shift(event.clientY < current.y ? 1 : -1);
  }

  return (
    <section
      id="trip-panel"
      className="panel"
      data-snap={snap}
      aria-label="Trip planner"
      data-map-overlay=""
      data-overlay-edge="left"
      data-overlay-edge-mobile="bottom"
    >
      <div className="sheet-handle">
        <button
          type="button"
          className="sheet-toggle"
          aria-expanded={snap !== "collapsed"}
          aria-controls="trip-panel-body"
          aria-label={`${snap} trip panel. ${ACTION[snap]}.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            press.current = null;
          }}
          onClick={() => {
            // A drag already moved the sheet; a tap or the keyboard cycles it.
            if (swallowClick.current) {
              swallowClick.current = false;
              return;
            }
            setSnap((current) => NEXT[current]);
          }}
        >
          <span className="grab-bar" aria-hidden="true" />
          <span className="sheet-title">{title}</span>
        </button>
      </div>
      <div id="trip-panel-body" className="panel-scroll">
        {children}
      </div>
    </section>
  );
}
