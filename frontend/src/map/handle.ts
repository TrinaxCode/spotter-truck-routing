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
  destroy: () => void;
}
