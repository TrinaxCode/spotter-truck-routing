import { memo, useEffect, useLayoutEffect, useRef } from "react";
import type { MapHandle } from "./handle";
import { createMapController, noteMapRender } from "./mapController";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapCanvasProps {
  onReady: (handle: MapHandle) => void;
  onInspect: (routeId: string, index: number) => void;
  onSelect: (routeId: string) => void;
}

export const MapCanvas = memo(function MapCanvas({ onReady, onInspect, onSelect }: MapCanvasProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  const inspectRef = useRef(onInspect);
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => {
    readyRef.current = onReady;
    inspectRef.current = onInspect;
    selectRef.current = onSelect;
  }, [onReady, onInspect, onSelect]);
  noteMapRender();

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    let handle: MapHandle | null = null;
    try {
      handle = createMapController(node, {
        theme,
        onReady: (next) => readyRef.current(next),
        onInspect: (routeId, index) => inspectRef.current(routeId, index),
        onSelect: (routeId) => selectRef.current(routeId),
      });
    } catch (error) {
      console.error(error);
      node.dataset.mapError = "1";
    }
    return () => handle?.destroy();
  }, []);

  return (
    <div ref={nodeRef} className="map-canvas" data-testid="map-canvas">
      <p className="map-fallback" data-map-error>
        The map could not start. Route details in the panel still work.
      </p>
    </div>
  );
});
