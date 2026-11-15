import type { MilesByLevel, PlanResponse, RouteOption } from "../api/types";
import { formatAvgRisk, formatClock, formatDuration, formatHosBreaks, formatMiles } from "../lib/format";
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
          style={{ width: `${(miles[part.key] / total) * 100}%` }}
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
}

export function RouteList({ plan, selectedId, onSelect, onInspect }: RouteListProps) {
  const ordered = [...plan.routes].sort((a, b) => a.rank - b.rank);
  return (
    <section className="routes" aria-label="Route options">
      {plan.warnings.length > 0 && (
        <ul className="warnings">
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {plan.recommendation.explanation.length > 0 && (
        <p className="recommend-lead">{plan.recommendation.explanation.join(" ")}</p>
      )}
      <ol>
        {ordered.map((route) => (
          <RouteCard
            key={route.id}
            route={route}
            selected={route.id === selectedId}
            explanation={[]}
            onSelect={() => onSelect(route.id)}
            onInspect={(index) => onInspect(route.id, index)}
          />
        ))}
      </ol>
    </section>
  );
}

interface RouteCardProps {
  route: RouteOption;
  selected: boolean;
  explanation: string[];
  onSelect: () => void;
  onInspect: (index: number) => void;
}

export function RouteCard({ route, selected, explanation, onSelect, onInspect }: RouteCardProps) {
  const coverage = route.summary.weather_coverage;
  const milesLabel = milesByLevelLabel(route.summary.miles_by_level);
  return (
    <li className="route" data-selected={selected} data-recommended={route.recommended} data-testid="route-card">
      <button type="button" className="route-main" aria-pressed={selected} onClick={onSelect}>
        <span className="rank" aria-hidden="true">
          {route.rank}
        </span>
        <span className="route-head">
          <span className="route-name">{route.label}</span>
          {route.recommended && <span className="recommend">Recommended</span>}
        </span>
        <span className="sr-only">{`Rank ${route.rank}. ${selected ? "Selected." : "Not selected."}`}</span>
        {explanation.length > 0 && (
          <span className="explain">
            {explanation.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )}
        <span className="stats">
          <span>{formatMiles(route.distance_mi)}</span>
          <span>Drive {formatDuration(route.drive_time_s)}</span>
          <span>Total {formatDuration(route.total_time_s)} incl. breaks</span>
          <span>Arrive {formatClock(route.arrival)}</span>
          <span>{formatHosBreaks(route.summary.breaks.length)}</span>
        </span>
        <MilesBar miles={route.summary.miles_by_level} label={milesLabel} />
        <span className="risk-line">
          Avg risk {formatAvgRisk(route.summary.avg_risk)} · Max {riskLabel(route.summary.max_level)}
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
                <span>Mile {checkpoint.mile.toFixed(1)}</span>
                <span>{checkpoint.level_label}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
