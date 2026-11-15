import { useState, type ReactNode } from "react";

type Snap = "collapsed" | "half" | "expanded";

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

function initialSnap(): Snap {
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches) return "expanded";
  return "half";
}

export function TripSheet({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snap>(initialSnap);

  return (
    <section id="trip-panel" className="panel" data-snap={snap} aria-label="Trip planner">
      <div className="sheet-handle">
        <button
          type="button"
          className="sheet-toggle"
          aria-expanded={snap !== "collapsed"}
          aria-controls="trip-panel-body"
          aria-label={`${snap} trip panel. ${ACTION[snap]}.`}
          onClick={() => setSnap((current) => NEXT[current])}
        >
          <span className="grab-bar" aria-hidden="true" />
          <span className="sheet-state">{snap}</span>
        </button>
      </div>
      <div id="trip-panel-body" className="panel-scroll">
        {children}
      </div>
    </section>
  );
}
