/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_USE_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface SpotterProbe {
  sourceUpdates: number;
  paintUpdates: number;
  /** Writes to the one-feature truck source (trip playback). */
  truckUpdates: number;
  /** Checkpoint ring changes from the weather profile (feature-state). */
  featureStateUpdates: number;
  mapRenders: number;
  frame: number;
  variable: string;
}

interface Window {
  __spotter?: SpotterProbe;
}
