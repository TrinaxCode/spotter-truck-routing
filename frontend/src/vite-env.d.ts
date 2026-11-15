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
  mapRenders: number;
  frame: number;
  variable: string;
}

interface Window {
  __spotter?: SpotterProbe;
}
