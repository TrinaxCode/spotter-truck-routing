import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MapHandle } from "./handle";
import { createMapController, noteMapRender } from "./mapController";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapCanvasProps {
  onReady: (handle: MapHandle) => void;
  onInspect: (routeId: string, index: number) => void;
  onSelect: (routeId: string) => void;
  onChaseChange: (following: boolean) => void;
}

export const MapCanvas = memo(function MapCanvas({ onReady, onInspect, onSelect, onChaseChange }: MapCanvasProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  const inspectRef = useRef(onInspect);
  const selectRef = useRef(onSelect);
  const chaseRef = useRef(onChaseChange);
  /** Bumped by Retry; each value builds a fresh map and App replays the plan onto it via onReady. */
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  useLayoutEffect(() => {
    readyRef.current = onReady;
    inspectRef.current = onInspect;
    selectRef.current = onSelect;
    chaseRef.current = onChaseChange;
  }, [onReady, onInspect, onSelect, onChaseChange]);
  noteMapRender();

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    let handle: MapHandle | null = null;
    let cancelled = false;
    const fail = (reason: string) => {
      if (!cancelled) setFailure(reason);
    };
    try {
      handle = createMapController(node, {
        theme,
        onReady: (next) => readyRef.current(next),
        onInspect: (routeId, index) => inspectRef.current(routeId, index),
        onSelect: (routeId) => selectRef.current(routeId),
        onStyleError: fail,
        onChaseChange: (following) => chaseRef.current(following),
      });
    } catch (error) {
      console.error(error);
      queueMicrotask(() => fail("The map could not start."));
    }
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [attempt]);

  return (
    <>
      <div ref={nodeRef} className="map-canvas" data-testid="map-canvas" />
      {failure !== null && (
        <div className="map-error" role="alert" data-testid="map-error">
          <p className="map-error-title">The map did not load</p>
          <p>Route details in the panel still work. Check your connection, then try again.</p>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setFailure(null);
              setAttempt((count) => count + 1);
            }}
          >
            Retry map
          </button>
        </div>
      )}
    </>
  );
});
