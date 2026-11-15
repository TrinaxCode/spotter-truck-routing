import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api/errors";
import { api } from "./api/client";
import type { Checkpoint, HeatmapResponse, HeatVariable, PlanResponse, RouteOption } from "./api/types";
import { CheckpointDialog } from "./components/CheckpointDialog";
import { HeatmapBar } from "./components/HeatmapBar";
import { PlanForm } from "./components/PlanForm";
import { RouteList } from "./components/RouteList";
import { EmptyState, ErrorNote, Legend, MapSkeleton, RouteSkeleton } from "./components/States";
import { TripSheet } from "./components/TripSheet";
import { TripSummary } from "./components/TripSummary";
import { draftToRequest, type FieldErrors, type TripDraft } from "./lib/form";
import type { MapHandle } from "./map/handle";

const MapCanvas = lazy(() => import("./map/MapCanvas").then((module) => ({ default: module.MapCanvas })));

type PlanStatus = "empty" | "loading" | "ready" | "error";
type HeatStatus = "idle" | "loading" | "ready" | "error";

function fieldErrors(fields?: Record<string, string>): FieldErrors {
  if (!fields) return {};
  return {
    origin: fields.origin,
    destination: fields.destination,
    departure: fields.departure,
    load: fields.load_lbs ?? fields.load,
  };
}

export function App() {
  const mapRef = useRef<MapHandle | null>(null);
  const planRef = useRef<PlanResponse | null>(null);
  const queued = useRef<{ plan: PlanResponse | null; heat: HeatmapResponse | null; selected: string | null }>({
    plan: null,
    heat: null,
    selected: null,
  });
  const draftRef = useRef<TripDraft | null>(null);
  const frameRef = useRef<{ hour: number; variable: HeatVariable; visible: boolean }>({
    hour: 0,
    variable: "risk",
    visible: true,
  });
  const abortRef = useRef<AbortController | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<PlanStatus>("empty");
  const [planError, setPlanError] = useState("");
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [heatStatus, setHeatStatus] = useState<HeatStatus>("idle");
  const [heatError, setHeatError] = useState("");
  const [heatStart, setHeatStart] = useState<string | null>(null);
  const [inspect, setInspect] = useState<{ route: RouteOption; checkpoint: Checkpoint } | null>(null);
  const [submitted, setSubmitted] = useState<TripDraft | null>(null);
  const [editing, setEditing] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  const mocks = import.meta.env.VITE_USE_MOCKS === "true";

  function rememberPlan(next: PlanResponse | null) {
    planRef.current = next;
    setPlan(next);
  }

  const onReady = useCallback((handle: MapHandle) => {
    mapRef.current = handle;
    const pending = queued.current;
    if (pending.plan) handle.setPlan(pending.plan);
    if (pending.selected) handle.setSelected(pending.selected);
    if (pending.heat) handle.setHeatmap(pending.heat);
    const frame = frameRef.current;
    handle.setFrame(frame.hour, frame.variable, frame.visible);
  }, []);

  const openCheckpoint = useCallback((routeId: string, index: number) => {
    const route = planRef.current?.routes.find((item) => item.id === routeId);
    const checkpoint = route?.checkpoints.find((item) => item.index === index);
    if (route && checkpoint) setInspect({ route, checkpoint });
  }, []);

  const onFrame = useCallback((hour: number, variable: HeatVariable, visible: boolean) => {
    frameRef.current = { hour, variable, visible };
    mapRef.current?.setFrame(hour, variable, visible);
  }, []);

  const closeInspect = useCallback(() => setInspect(null), []);

  const loadHeat = useCallback(async (planId: string) => {
    setHeatStatus("loading");
    setHeatError("");
    try {
      const heat = await api.fetchHeatmap(planId, abortRef.current?.signal);
      setHeatStart(heat.start);
      setHeatStatus("ready");
      queued.current.heat = heat;
      mapRef.current?.setHeatmap(heat);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHeatStart(null);
      setHeatStatus("error");
      setHeatError(error instanceof ApiError ? error.message : "The forecast did not load.");
    }
  }, []);

  async function run(draft: TripDraft) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    draftRef.current = draft;
    setStatus("loading");
    setPlanError("");
    setServerErrors({});
    setInspect(null);
    setHeatStatus("idle");
    setHeatStart(null);
    try {
      const next = await api.planRoutes(draftToRequest(draft), controller.signal);
      if (controller.signal.aborted) return;
      rememberPlan(next);
      setSelectedId(next.recommended_route_id);
      setSubmitted(draft);
      setEditing(false);
      setStatus("ready");
      queued.current = { plan: next, heat: null, selected: next.recommended_route_id };
      mapRef.current?.setPlan(next);
      void loadHeat(next.plan_id);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setStatus("error");
      if (error instanceof ApiError) {
        setPlanError(error.message);
        setServerErrors(fieldErrors(error.fields));
      } else {
        setPlanError("The dispatch service could not be reached.");
      }
    }
  }

  useEffect(() => {
    if (status !== "ready" || editing) return;
    document.getElementById("trip-panel-body")?.scrollTo(0, 0);
  }, [status, editing, plan?.plan_id]);

  const selectRoute = useCallback((routeId: string) => {
    setSelectedId(routeId);
    queued.current.selected = routeId;
    mapRef.current?.setSelected(routeId);
  }, []);

  return (
    <div className="shell min-h-dvh font-sans">
      <a className="skip" href="#trip-panel">
        Skip to trip planner
      </a>
      <header className="mast">
        <div className="brand">
          <p className="mark">Spotter</p>
          <h1>Dispatch</h1>
        </div>
        <div className="mast-actions">
          {mocks && <p className="demo-badge">Demo data</p>}
          <button
            type="button"
            aria-pressed={theme === "dark"}
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              document.documentElement.dataset.theme = next;
              localStorage.setItem("spotter-theme", next);
              setTheme(next);
              mapRef.current?.setBasemap(next);
            }}
          >
            Dark map
          </button>
        </div>
      </header>
      <div className="stage">
        <TripSheet>
          {submitted && status === "ready" && !editing && (
            <TripSummary draft={submitted} onEdit={() => setEditing(true)} />
          )}
          <div hidden={status === "ready" && !editing}>
            <PlanForm
              busy={status === "loading"}
              serverErrors={serverErrors}
              search={async (query, signal) => (await api.geocode(query, signal)).results}
              onPlan={(draft) => {
                void run(draft);
              }}
            />
          </div>
          {status === "empty" && <EmptyState />}
          {status === "loading" && <RouteSkeleton />}
          {status === "error" && (
            <ErrorNote
              message={planError}
              onRetry={() => {
                if (draftRef.current) void run(draftRef.current);
              }}
            />
          )}
          {plan && status === "ready" && (
            <RouteList
              plan={plan}
              selectedId={selectedId ?? plan.recommended_route_id}
              onSelect={selectRoute}
              onInspect={(routeId, index) => {
                openCheckpoint(routeId, index);
                mapRef.current?.showCheckpoint(routeId, index);
              }}
            />
          )}
        </TripSheet>
        <div className="map-stage">
          <Suspense fallback={<MapSkeleton />}>
            <MapCanvas onReady={onReady} onInspect={openCheckpoint} onSelect={selectRoute} />
          </Suspense>
          <Legend />
          {inspect && (
            <CheckpointDialog
              route={inspect.route}
              checkpoint={inspect.checkpoint}
              onClose={closeInspect}
            />
          )}
        </div>
      </div>
      <HeatmapBar
        key={heatStart ?? "idle"}
        startIso={heatStart}
        status={heatStatus}
        error={heatError}
        onRetry={() => {
          if (plan) void loadHeat(plan.plan_id);
        }}
        onFrame={onFrame}
      />
    </div>
  );
}
