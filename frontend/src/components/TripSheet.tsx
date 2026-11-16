import { useEffect, useRef, useState, type ReactNode } from "react";
import { attachSheetDrag, type Snap } from "../hooks/useDragSnap";
import "../styles/sheet-gestures.css";

const ACTION: Record<Snap, string> = {
  collapsed: "Show the trip panel halfway",
  half: "Expand the trip panel",
  expanded: "Collapse the trip panel",
};

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
  /**
   * Changes while a checkpoint card is open. An expanded phone sheet then drops to the half snap
   * so the card, which floats above the dock, still has room inside the viewport.
   */
  lowerKey?: string | null;
  children: ReactNode;
}

/**
 * Floating card on desktop and tablet. On phones, a bottom sheet: drag the handle (or pull the
 * body down when it is scrolled to the top) and it follows the finger, then snaps to collapsed,
 * half or expanded. A flick moves one snap. The handle button and Enter/Space still cycle snaps.
 */
export function TripSheet({ title, settleKey, lowerKey, children }: TripSheetProps) {
  const [snap, setSnap] = useState<Snap>(initialSnap);
  const [seenKey, setSeenKey] = useState(settleKey ?? null);
  const [seenLower, setSeenLower] = useState(lowerKey ?? null);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  });
  useEffect(() => {
    const panel = panelRef.current;
    const scroll = scrollRef.current;
    if (!panel || !scroll) return;
    return attachSheetDrag(panel, scroll, snapRef, setSnap);
  }, []);

  if ((settleKey ?? null) !== seenKey) {
    setSeenKey(settleKey ?? null);
    if (settleKey && isPhone()) setSnap("half");
  }

  if ((lowerKey ?? null) !== seenLower) {
    setSeenLower(lowerKey ?? null);
    // Driving needs the map: the sheet folds away entirely; a checkpoint card only needs room.
    if (lowerKey === "drive" && isPhone()) setSnap("collapsed");
    else if (lowerKey && isPhone() && snap === "expanded") setSnap("half");
  }

  return (
    <section
      ref={panelRef}
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
          // WCAG 2.5.3: the accessible name starts with the visible title.
          aria-label={`${title}. ${snap} trip panel. ${ACTION[snap]}.`}
        >
          <span className="grab-bar" aria-hidden="true" />
          <span className="sheet-title">{title}</span>
        </button>
      </div>
      <div id="trip-panel-body" ref={scrollRef} className="panel-scroll">
        {children}
      </div>
    </section>
  );
}
