import { useEffect, useRef, type ReactNode } from "react";
import type { MilesByLevel, PlanResponse, RouteOption } from "../api/types";
import { useIsPhone } from "../hooks/useIsPhone";
import { routeStepFromSwipe, ROUTE_SWIPE_PX, slideFeedback, useAxisClaim } from "../hooks/useSwipe";
import { formatDuration, formatHosBreaks, formatMiles, formatShortClock } from "../lib/format";
import { describeRecommendation } from "../lib/recommend";
import { milesByLevelLabel, riskLabel } from "../lib/riskColor";

const MILE_PARTS: { key: keyof MilesByLevel; className: string }[] = [
  { key: "low", className: "mile-low" },
  { key: "moderate", className: "mile-moderate" },
  { key: "high", className: "mile-high" },
  { key: "severe", className: "mile-severe" },
  { key: "no_travel", className: "mile-halt" },
  { key: "unknown", className: "mile-unknown" },
];

export function MilesBar({ miles, label }: { miles: MilesByLevel; label?: string }) {
  const text = label ?? milesByLevelLabel(miles);
  const total = MILE_PARTS.reduce((sum, part) => sum + miles[part.key], 0) || 1;
  return (
    <div className="miles" role="img" aria-label={text}>
      {MILE_PARTS.filter((part) => miles[part.key] > 0).map((part) => (
        <span
          key={part.key}
          className={part.className}
          style={{ flexGrow: miles[part.key] / total, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

interface RouteListProps {
  plan: PlanResponse;
  selectedId: string;
  onSelect: (routeId: string) => void;
  onInspect: (routeId: string, index: number) => void;
  onHover?: (routeId: string | null) => void;
  /** Rendered between the warnings and the route cards ("best time to leave"). */
  beforeRoutes?: ReactNode;
  /** Rendered under the route cards (the selected route's weather profile and trip playback). */
  afterRoutes?: ReactNode;
}

export function RouteList({ plan, selectedId, onSelect, onInspect, onHover, beforeRoutes, afterRoutes }: RouteListProps) {
  const ordered = [...plan.routes].sort((a, b) => a.rank - b.rank);
  const recommendation = describeRecommendation(plan);
  const reasons = plan.recommendation.explanation;
  const phone = useIsPhone();
  const orderedRef = useRef(ordered);
  const selectedRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const cardRef = useRef<HTMLElement | null>(null);
  const resetTimer = useRef(0);
  useEffect(() => {
    orderedRef.current = ordered;
    selectedRef.current = selectedId;
    onSelectRef.current = onSelect;
  });

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const releaseCard = (card: HTMLElement | null) => {
    if (!card) return;
    card.dataset.dragging = "settle";
    card.style.transform = "translateX(0px)";
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      card.style.transform = "";
      delete card.dataset.dragging;
    }, 220);
  };

  const listRef = useAxisClaim<HTMLOListElement>({
    enabled: phone,
    claim: "x",
    swallowAt: ROUTE_SWIPE_PX,
    onClaim: (event) => {
      const target = event.target;
      cardRef.current = target instanceof Element ? target.closest<HTMLElement>("[data-testid='route-card']") : null;
    },
    onMove: ({ dx }) => {
      const card = cardRef.current;
      if (!card) return;
      card.dataset.dragging = "true";
      card.style.transform = `translateX(${slideFeedback(dx).toFixed(2)}px)`;
    },
    onEnd: ({ dx }) => {
      const routes = orderedRef.current;
      const index = routes.findIndex((route) => route.id === selectedRef.current);
      const step = routeStepFromSwipe(dx);
      const next = index + step;
      if (step !== 0 && next >= 0 && next < routes.length) {
        const id = routes[next].id;
        if (id !== selectedRef.current) onSelectRef.current(id);
      }
      const card = cardRef.current;
      cardRef.current = null;
      releaseCard(card);
    },
    onCancel: () => {
      const card = cardRef.current;
      cardRef.current = null;
      if (!card) return;
      card.style.transform = "";
      delete card.dataset.dragging;
    },
  });

  return (
    <section className="routes" aria-label="Route options">
      {recommendation && (
        <div className="callout" data-tone={recommendation.caution ? "caution" : "good"}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d={recommendation.caution ? "M10 5.5v5.2M10 13.6v.1" : "m6.3 10.3 2.4 2.4 5-5.4"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div>
            <p className="callout-lead">{recommendation.headline}</p>
            {reasons.length > 0 && <p className="callout-why">{reasons.join(" ")}</p>}
          </div>
        </div>
      )}
      {plan.warnings.length > 0 && (
        <ul className="warnings">
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {beforeRoutes}
      <h2 className="section-title">Routes</h2>
      <ol ref={listRef} onPointerLeave={() => onHover?.(null)}>
        {ordered.map((route) => (
          <RouteCard
            key={route.id}
            route={route}
            selected={route.id === selectedId}
            explanation={[]}
            onSelect={() => onSelect(route.id)}
            onInspect={(index) => onInspect(route.id, index)}
            onHover={onHover ? (on) => onHover(on ? route.id : null) : undefined}
          />
        ))}
      </ol>
      {afterRoutes}
    </section>
  );
}

interface RouteCardProps {
  route: RouteOption;
  selected: boolean;
  explanation: string[];
  onSelect: () => void;
  onInspect: (index: number) => void;
  onHover?: (on: boolean) => void;
}

export function RouteCard({ route, selected, explanation, onSelect, onInspect, onHover }: RouteCardProps) {
  const coverage = route.summary.weather_coverage;
  const miles = route.summary.miles_by_level;
  const milesLabel = milesByLevelLabel(miles);
  const worst = route.summary.max_level;
  const exposed = miles.high + miles.severe + miles.no_travel;
  return (
    <li
      className="route"
      data-selected={selected}
      data-recommended={route.recommended}
      data-testid="route-card"
      onPointerEnter={onHover ? () => onHover(true) : undefined}
      onFocus={onHover ? () => onHover(true) : undefined}
      onBlur={onHover ? () => onHover(false) : undefined}
    >
      <button type="button" className="route-main" aria-pressed={selected} onClick={onSelect}>
        <span className="route-top">
          <span className="rank" aria-hidden="true">
            {route.rank}
          </span>
          <span className="route-name">{route.label}</span>
          {route.recommended && <span className="recommend">Recommended</span>}
          <span className="pill" data-level={worst ?? "unknown"}>
            <span className="sr-only">Worst level: </span>
            {riskLabel(worst)}
          </span>
        </span>
        <span className="sr-only">{`Rank ${route.rank}. ${selected ? "Selected." : "Not selected."}`}</span>
        {explanation.length > 0 && (
          <span className="explain">
            {explanation.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )}
        <span className="stat-grid">
          <span className="stat">
            <span className="stat-label">Distance</span>
            <span className="stat-value">{formatMiles(route.distance_mi)}</span>
          </span>
          <span className="stat">
            <span className="stat-label">Drive</span>
            <span className="stat-value">{formatDuration(route.drive_time_s)}</span>
          </span>
          <span className="stat">
            <span className="stat-label">Arrival</span>
            <span className="stat-value">{formatShortClock(route.arrival)}</span>
          </span>
        </span>
        <span className="route-sub">
          <span>Total {formatDuration(route.total_time_s)} incl. breaks</span>
          <span className="dot" aria-hidden="true" />
          <span>{formatHosBreaks(route.summary.breaks.length)}</span>
        </span>
        <MilesBar miles={miles} label={milesLabel} />
        <span className="route-risk">
          <span>Avg risk {route.summary.avg_risk.toFixed(2)}</span>
          {exposed > 0 && <span>{formatMiles(exposed)} High or worse</span>}
        </span>
        {coverage < 1 && (
          <span className="coverage-line">
            Weather coverage {Math.round(coverage * 100)}%. Missing forecast is not treated as low risk.
          </span>
        )}
      </button>
      <details className="checks">
        <summary>Checkpoints ({route.checkpoints.length})</summary>
        <ul>
          {route.checkpoints.map((checkpoint) => (
            <li key={checkpoint.index}>
              <button type="button" data-testid="checkpoint-button" onClick={() => onInspect(checkpoint.index)}>
                <span className="check-dot" data-level={checkpoint.level ?? "unknown"} aria-hidden="true" />
                <span>Mile {checkpoint.mile.toFixed(1)}</span>
                <span className="check-level">{checkpoint.level_label}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
