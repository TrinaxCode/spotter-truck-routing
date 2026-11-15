import type { HeatmapResponse, HeatVariable, PlanResponse } from "../api/types";

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
  destroy: () => void;
}
