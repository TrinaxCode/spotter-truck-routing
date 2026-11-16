import type { HeatmapResponse, HeatVariable, PlanResponse } from "../api/types";

/** The truck marker of the trip playback (SPEC §12.3). */
export interface TruckPosition {
  lon: number;
  lat: number;
  /** Degrees clockwise from north. */
  bearing: number;
  /** True while the truck stands at an HOS break. */
  stopped: boolean;
}

/** Read-only development diagnostics for real-touch E2E; no map mutation API. */
export interface MapGestureProbe {
  camera: () => { zoom: number; bearing: number; pitch: number; pitching: boolean };
  routes: () => { id: string; selected: boolean; points: { x: number; y: number }[]; checkpoints: { x: number; y: number; index: number }[] }[];
}

export interface MapHandle {
  setPlan: (plan: PlanResponse) => void;
  setSelected: (routeId: string) => void;
  /** Lights up one route line (e.g. while its card is hovered); null clears it. Filter change only. */
  setHover: (routeId: string | null) => void;
  setHeatmap: (data: HeatmapResponse) => void;
  /** Hour changes call setPaintProperty only. No setData and no source rebuild. */
  setFrame: (hour: number, variable: HeatVariable, visible: boolean) => void;
  setBasemap: (theme: "light" | "dark") => void;
  showCheckpoint: (routeId: string, index: number) => void;
  /** Ring around one checkpoint of the selected route (feature-state only); null clears it. */
  setFocus: (routeId: string | null, index?: number) => void;
  /** Moves the truck. Writes only the one-feature truck source; null removes the truck. */
  setTruck: (truck: TruckPosition | null) => void;
  /** Chase camera on/off while a truck is on the map (tilted follow view vs. free map). */
  setChase: (on: boolean) => void;
  destroy: () => void;
}
