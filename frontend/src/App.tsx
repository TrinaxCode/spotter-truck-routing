import { flushSync } from "react-dom";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, describeApiError, flattenFieldErrors, isRetryable, type FieldIssues } from "./api/errors";
import { api } from "./api/client";
import type {
  Checkpoint,
  DepartureOptionsResponse,
  HeatmapResponse,
  HeatVariable,
  PlanResponse,
  RouteOption,
} from "./api/types";
import { CheckpointDialog } from "./components/CheckpointDialog";
import { DepartureStrip, type DepartureStatus } from "./components/DepartureStrip";
import { HeatmapBar } from "./components/HeatmapBar";
import { PlanForm } from "./components/PlanForm";
import { RouteList } from "./components/RouteList";
import { EmptyState, ErrorNote, MapSkeleton, RouteSkeleton } from "./components/States";
import { TripProfile } from "./components/TripProfile";
import { TripSheet } from "./components/TripSheet";
import { TripSummary } from "./components/TripSummary";
import { QuickStart } from "./components/QuickStart";
import { DriverBriefing } from "./components/DriverBriefing";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { DRIVE_TOGGLE_EVENT, shortcutFor } from "./lib/shortcuts";
import { ToastMessage, ToastRegion } from "./components/Toast";
import { draftToSearch, draftToTemplate, loadRecentTrips, rememberTrip, searchToDraft, templateToDraft, type TripTemplate } from "./lib/trips";
import { heatmapCoverage, type HeatCoverage } from "./lib/heatmap";
import { draftToRequest, type FieldErrors, type TripDraft } from "./lib/form";
import { shortPlace } from "./lib/format";
import { toLocalInput } from "./lib/time";
import type { TripSample } from "./lib/tripTimeline";
import type { MapHandle } from "./map/handle";

const MapCanvas = lazy(() => import("./map/MapCanvas").then((module) => ({ default: module.MapCanvas })));

type PlanStatus = "empty" | "loading" | "ready" | "error";
type HeatStatus = "idle" | "loading" | "ready" | "error";

function fieldErrors(issues?: FieldIssues): FieldErrors {
  const fields = flattenFieldErrors(issues);
  return {
    origin: fields.origin,
    destination: fields.destination,
    departure: fields.departure,
    load: fields.load_lbs,
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
  const [recent, setRecent] = useState<TripTemplate[]>(() => loadRecentTrips());
  const [draftSync, setDraftSync] = useState<{ draft: TripDraft; token: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [sharedDraft] = useState(() => (typeof window === "undefined" ? null : searchToDraft(window.location.search)));
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
  const [planRetryable, setPlanRetryable] = useState(true);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [heatStatus, setHeatStatus] = useState<HeatStatus>("idle");
  const [heatError, setHeatError] = useState("");
  const [heatStart, setHeatStart] = useState<string | null>(null);
  const [heatCoverage, setHeatCoverage] = useState<Record<HeatVariable, HeatCoverage> | null>(null);
  const [heatData, setHeatData] = useState<HeatmapResponse | null>(null);
  const [departures, setDepartures] = useState<{
    status: DepartureStatus;
    data: DepartureOptionsResponse | null;
    error: string;
  }>({ status: "idle", data: null, error: "" });
  const [followHour, setFollowHour] = useState<number | null>(null);
  const [tripPlaying, setTripPlaying] = useState(false);
  const [departureSync, setDepartureSync] = useState<{ local: string; token: number } | null>(null);
  const [inspect, setInspect] = useState<{ route: RouteOption; checkpoint: Checkpoint } | null>(null);
  const [submitted, setSubmitted] = useState<TripDraft | null>(null);
  const [pending, setPending] = useState<TripDraft | null>(null);
  const [editing, setEditing] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );


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
      setHeatCoverage(heatmapCoverage(heat));
      setHeatData(heat);
      setHeatStatus("ready");
      queued.current.heat = heat;
      mapRef.current?.setHeatmap(heat);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHeatStart(null);
      setHeatCoverage(null);
      setHeatStatus("error");
      setHeatError(describeApiError(error, "The forecast did not load."));
    }
  }, []);

  const loadDepartures = useCallback(async (planId: string) => {
    setDepartures({ status: "loading", data: null, error: "" });
    try {
      const data = await api.fetchDepartureOptions(planId, abortRef.current?.signal);
      setDepartures({ status: "ready", data, error: "" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      // Departure options are advice on top of the plan; a failure here never blocks the plan.
      setDepartures({
        status: "error",
        data: null,
        error: describeApiError(error, "Departure options did not load."),
      });
    }
  }, []);

  async function run(draft: TripDraft) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    draftRef.current = draft;
    setPending(draft);
    setStatus("loading");
    setPlanError("");
    setPlanRetryable(true);
    setServerErrors({});
    setInspect(null);
    setHeatStatus("idle");
    setHeatStart(null);
    setHeatCoverage(null);
    setDepartures({ status: "idle", data: null, error: "" });
    setFollowHour(null);
    setTripPlaying(false);
    try {
      const next = await api.planRoutes(draftToRequest(draft), controller.signal);
      if (controller.signal.aborted) return;
      rememberPlan(next);
      setPending(null);
      setSelectedId(next.recommended_route_id);
      setSubmitted(draft);
      setEditing(false);
      setStatus("ready");
      const template = draftToTemplate(draft);
      if (template) setRecent(rememberTrip(template));
      // The address bar always holds a link that reopens this exact trip.
      const search = draftToSearch(draft);
      if (search) window.history.replaceState(null, "", `${window.location.pathname}${search}`);
      queued.current = { plan: next, heat: null, selected: next.recommended_route_id };
      mapRef.current?.setPlan(next);
      void loadHeat(next.plan_id);
      void loadDepartures(next.plan_id);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setPending(null);
      setStatus("error");
      setPlanError(describeApiError(error, "The routing service could not be reached."));
      setPlanRetryable(isRetryable(error));
      setServerErrors(fieldErrors(error instanceof ApiError ? error.fields : undefined));
    }
  }

  /** Plans a trip that did not come from the form (example, recent trip, shared link) and mirrors it there. */
  function startTrip(draft: TripDraft) {
    setDraftSync((current) => ({ draft, token: (current?.token ?? 0) + 1 }));
    void run(draft);
  }
  const startRef = useRef(startTrip);
  useLayoutEffect(() => {
    startRef.current = startTrip;
  });
  // A shared link opens straight into its plan.
  useEffect(() => {
    if (sharedDraft) startRef.current(sharedDraft);
  }, [sharedDraft]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("headwind-theme", next);
    } catch {
      // Storage can be blocked; the theme still applies for this visit.
    }
    setTheme(next);
    mapRef.current?.setBasemap(next);
  }

  // The briefing exists only while printing (button, "P" or the browser's own print command).
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  const [helpOpen, setHelpOpen] = useState(false);
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useLayoutEffect(() => {
    shortcutRef.current = (event: KeyboardEvent) => {
      const action = shortcutFor(event);
      if (!action || helpOpen) return;
      const ready = status === "ready" && plan != null;
      if (action === "help") setHelpOpen(true);
      else if (action === "theme") toggleTheme();
      else if (!ready) return;
      else if (action.startsWith("route-")) {
        const route = plan.routes.find((item) => item.rank === Number(action.slice(6)));
        if (route) selectRoute(route.id);
      } else if (action === "drive") window.dispatchEvent(new Event(DRIVE_TOGGLE_EVENT));
      else if (action === "edit") setEditing(true);
      else if (action === "share") void shareTrip();
      else if (action === "print") window.print();
      event.preventDefault();
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const notify = useCallback((text: string) => setToast({ text, id: Date.now() }), []);
  const clearToast = useCallback(() => setToast(null), []);
  async function shareTrip() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      notify("Link copied. Anyone who opens it sees this trip.");
    } catch {
      notify("Copy the address bar to share this trip.");
    }
  }

  // The free-tier API host sleeps when idle; wake it while the driver fills in the form.
  useEffect(() => {
    const controller = new AbortController();
    api.health(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Swapping the form for the results (or back) removes the focused control; hand focus on.
  useEffect(() => {
    // While planning the form gives way to a progress card; after a failure the form comes back.
    if (status === "loading") {
      document.getElementById("plan-progress")?.focus({ preventScroll: true });
      return;
    }
    if (status === "error") {
      document.querySelector<HTMLElement>('[data-testid="plan-submit"]')?.focus({ preventScroll: true });
      return;
    }
    if (status !== "ready") return;
    const active = document.activeElement;
    const lost = !active || active === document.body || active.closest("[hidden]") !== null;
    if (editing) {
      if (lost) document.getElementById("origin")?.focus();
      return;
    }
    document.getElementById("trip-panel-body")?.scrollTo(0, 0);
    if (lost) {
      document.querySelector<HTMLElement>('#trip-panel-body [data-selected="true"] .route-main')?.focus({
        preventScroll: true,
      });
    }
  }, [status, editing, plan?.plan_id]);

  const hoverRoute = useCallback((routeId: string | null) => {
    mapRef.current?.setHover(routeId);
  }, []);

  // The phone dock (sheet + timeline) publishes its height so the checkpoint card can sit above it.
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = dockRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const publish = () => document.documentElement.style.setProperty("--dock-h", `${node.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const labelOf = useCallback(
    (routeId: string) => plan?.routes.find((route) => route.id === routeId)?.label ?? routeId,
    [plan],
  );

  /** Re-plans the same trip leaving at a suggested time. */
  function applyDeparture(departureIso: string) {
    const draft = draftRef.current;
    if (!draft) return;
    const local = toLocalInput(new Date(departureIso));
    setDepartureSync((current) => ({ local, token: (current?.token ?? 0) + 1 }));
    void run({ ...draft, departureLocal: local });
  }

  const onTruck = useCallback((sample: TripSample | null) => {
    mapRef.current?.setTruck(
      sample ? { lon: sample.lon, lat: sample.lat, bearing: sample.bearing, stopped: sample.stop !== null } : null,
    );
  }, []);

  const [following, setFollowing] = useState(false);
  const followTruck = useCallback((on: boolean) => {
    mapRef.current?.setChase(on);
  }, []);

  const onFocusCheckpoint = useCallback((routeId: string, index: number | null) => {
    mapRef.current?.setFocus(index == null ? null : routeId, index ?? undefined);
  }, []);

  const selectRoute = useCallback((routeId: string) => {
    setSelectedId(routeId);
    queued.current.selected = routeId;
    mapRef.current?.setSelected(routeId);
  }, []);

  const selectedRoute = plan?.routes.find((route) => route.id === (selectedId ?? plan.recommended_route_id));

  const title = submitted && status === "ready"
    ? `${shortPlace(submitted.origin?.label ?? "Origin")} → ${shortPlace(submitted.destination?.label ?? "Destination")}`
    : "Plan a trip";

  return (
    <div className="app font-sans">
      <a className="skip" href="#trip-panel">
        Skip to trip planner
      </a>
      <p className="sr-only" role="status">
        {status === "ready" && plan
          ? `${plan.routes.length} routes scored. Top pick: ${
              plan.routes.find((route) => route.recommended)?.label ?? "none"
            }.`
          : ""}
      </p>
      <div className="map-stage">
        <Suspense fallback={<MapSkeleton />}>
          <MapCanvas onReady={onReady} onInspect={openCheckpoint} onSelect={selectRoute} onChaseChange={setFollowing} />
        </Suspense>
      </div>
      <header className="mast" data-map-overlay="" data-overlay-edge="left" data-overlay-edge-mobile="top">
        <h1 className="mast-title">
          {status === "ready" ? "Route options" : status === "loading" ? "Planning…" : "Plan a trip"}
        </h1>
        <div className="mast-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setHelpOpen(true)}
          >
            <KeyboardIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            title={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <MoonIcon /> : <SunIcon />}
          </button>
        </div>
      </header>
      <div ref={dockRef} className="dock">
        <TripSheet
          title={title}
          settleKey={status === "ready" ? plan?.plan_id : null}
          lowerKey={inspect ? `${inspect.route.id}:${inspect.checkpoint.index}` : tripPlaying ? "drive" : null}
        >
          {status === "empty" && <EmptyState />}
          {submitted && status === "ready" && !editing && (
            <TripSummary
              draft={submitted}
              onEdit={() => setEditing(true)}
              onShare={() => void shareTrip()}
              onPrint={() => window.print()}
            />
          )}
          {status === "loading" && pending && <TripSummary draft={pending} busy />}
          <div hidden={status === "loading" || (status === "ready" && !editing)}>
            <PlanForm
              busy={status === "loading"}
              serverErrors={serverErrors}
              search={async (query, signal) => (await api.geocode(query, signal)).results}
              departureSync={departureSync}
              draftSync={draftSync}
              onPlan={(draft) => {
                void run(draft);
              }}
            />
          </div>
          {status === "empty" && (
            <QuickStart recent={recent} disabled={false} onPick={(trip) => startTrip(templateToDraft(trip))} />
          )}
          {status === "loading" && <RouteSkeleton />}
          {status === "error" && (
            <ErrorNote
              message={planError}
              onRetry={
                planRetryable
                  ? () => {
                      if (draftRef.current) void run(draftRef.current);
                    }
                  : undefined
              }
            />
          )}
          {plan && status === "ready" && <div id="drive-slot" />}
          {plan && status === "ready" && (
            <RouteList
              plan={plan}
              selectedId={selectedId ?? plan.recommended_route_id}
              onSelect={selectRoute}
              onHover={hoverRoute}
              onInspect={(routeId, index) => {
                openCheckpoint(routeId, index);
                mapRef.current?.showCheckpoint(routeId, index);
              }}
              beforeRoutes={
                <DepartureStrip
                  key={plan.plan_id}
                  status={departures.status}
                  data={departures.data}
                  error={departures.error}
                  labelOf={labelOf}
                  generatedAt={plan.generated_at}
                  onRetry={() => void loadDepartures(plan.plan_id)}
                  onApply={applyDeparture}
                />
              }
              afterRoutes={
                selectedRoute && (
                  <TripProfile
                    key={`${plan.plan_id}:${selectedRoute.id}`}
                    route={selectedRoute}
                    heatStartIso={heatStart}
                    onTruck={onTruck}
                    onHour={setFollowHour}
                    onPlaying={setTripPlaying}
                    onFocusCheckpoint={onFocusCheckpoint}
                    following={following}
                    onFollow={followTruck}
                  />
                )
              }
            />
          )}
        </TripSheet>
        <HeatmapBar
          key={heatStart ?? "idle"}
          startIso={heatStart}
          departureIso={plan?.routes[0]?.departure ?? null}
          coverage={heatCoverage}
          status={heatStatus}
          error={heatError}
          onRetry={() => {
            if (plan) void loadHeat(plan.plan_id);
          }}
          onFrame={onFrame}
          followHour={followHour}
          locked={tripPlaying}
          heat={heatData}
        />
      </div>
      {inspect && (
        <CheckpointDialog route={inspect.route} checkpoint={inspect.checkpoint} onClose={closeInspect} />
      )}
      {printing && plan && status === "ready" && selectedRoute && submitted && (
        <DriverBriefing
          plan={plan}
          route={selectedRoute}
          origin={shortPlace(submitted.origin?.label ?? "Origin")}
          destination={shortPlace(submitted.destination?.label ?? "Destination")}
        />
      )}
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ToastRegion>{toast && <ToastMessage key={toast.id} text={toast.text} onDone={clearToast} />}</ToastRegion>
    </div>
  );
}

function KeyboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2" y="5" width="16" height="10" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.5 8.5h1M9.5 8.5h1M13.5 8.5h1M6.5 11.8h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M15.2 10.6A6.6 6.6 0 0 1 7.4 2.8a6.6 6.6 0 1 0 7.8 7.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
