import type {
  ErrorEnvelope,
  GeocodeResponse,
  HealthResponse,
  HeatmapResponse,
  PlanRequest,
  PlanResponse,
} from "./types";
import { ApiError } from "./errors";

export { ApiError } from "./errors";

/** Loaded only when mock mode is on, so live builds do not fetch the fixture chunk. */
function loadMocks() {
  return import("../mocks/mockApi");
}

export interface ApiClientOptions {
  baseUrl?: string;
  useMocks?: boolean;
  fetchFn?: typeof fetch;
  mockDelayMs?: number;
}

export interface ApiClient {
  health: (signal?: AbortSignal) => Promise<HealthResponse>;
  geocode: (query: string, signal?: AbortSignal) => Promise<GeocodeResponse>;
  planRoutes: (body: PlanRequest, signal?: AbortSignal) => Promise<PlanResponse>;
  fetchHeatmap: (planId: string, signal?: AbortSignal) => Promise<HeatmapResponse>;
}

function trimBase(url: string): string {
  return url.replace(/\/$/, "");
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = trimBase(options.baseUrl ?? import.meta.env.VITE_API_URL ?? "http://localhost:8000");
  const useMocks = options.useMocks ?? import.meta.env.VITE_USE_MOCKS === "true";
  const fetchFn = options.fetchFn ?? fetch;
  const mockDelayMs = options.mockDelayMs ?? 160;

  async function request<T>(path: string, init: RequestInit | undefined, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", "The dispatch service could not be reached.");
    }
    if (!response.ok) {
      let envelope: ErrorEnvelope | null = null;
      try {
        envelope = (await response.json()) as ErrorEnvelope;
      } catch {
        envelope = null;
      }
      throw new ApiError(
        response.status,
        envelope?.error.code ?? "http_error",
        envelope?.error.message ?? `Request failed (${response.status}).`,
        envelope?.error.fields,
      );
    }
    return (await response.json()) as T;
  }

  return {
    async health(signal) {
      if (useMocks) return (await loadMocks()).mockHealth(mockDelayMs, signal);
      return request<HealthResponse>("/api/health", { method: "GET" }, signal);
    },
    async geocode(query, signal) {
      if (useMocks) return (await loadMocks()).mockGeocode(query, mockDelayMs, signal);
      const params = new URLSearchParams({ q: query });
      return request<GeocodeResponse>(`/api/geocode?${params.toString()}`, { method: "GET" }, signal);
    },
    async planRoutes(body, signal) {
      if (useMocks) return (await loadMocks()).mockPlan(body, mockDelayMs, signal);
      return request<PlanResponse>(
        "/api/routes/plan",
        { method: "POST", body: JSON.stringify(body) },
        signal,
      );
    },
    async fetchHeatmap(planId, signal) {
      if (useMocks) return (await loadMocks()).mockHeatmap(planId, mockDelayMs, signal);
      const params = new URLSearchParams({ plan_id: planId });
      return request<HeatmapResponse>(`/api/heatmap?${params.toString()}`, { method: "GET" }, signal);
    },
  };
}

export const api = createApiClient();
