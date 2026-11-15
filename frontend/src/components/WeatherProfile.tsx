import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { RouteOption } from "../api/types";
import { buildProfile, profileSummary, readoutAtMile, formatReadout } from "../lib/profile";
import { riskColor } from "../lib/riskColor";
import { nearestCheckpoint, type Timeline } from "../lib/tripTimeline";

interface WeatherProfileProps {
  route: RouteOption;
  timeline: Timeline;
  /** Where the playback truck is, if there is one. */
  truckMile: number | null;
  /** The inspected mile (pointer or keyboard), or null. */
  cursorMile: number | null;
  onCursor: (mile: number | null) => void;
}

const FALLBACK_WIDTH = 340;
const KEY_STEPS: Record<string, number | undefined> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 };

/**
 * Weather profile of one route (SPEC §12.2): every coordinate comes from `buildProfile`, so the
 * chart is plain SVG at 1 px = 1 unit and stays crisp at any width. The wrapper is a slider over
 * route miles; arrows step checkpoint by checkpoint and a pointer scrubs continuously.
 */
export function WeatherProfile({ route, timeline, truckMile, cursorMile, onCursor }: WeatherProfileProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => buildProfile(route, timeline, width), [route, timeline, width]);
  const summary = useMemo(() => profileSummary(route, timeline), [route, timeline]);
  const readout = cursorMile == null ? null : readoutAtMile(route, timeline, cursorMile);

  function milesFromPointer(event: PointerEvent<HTMLDivElement>): number {
    const box = event.currentTarget.getBoundingClientRect();
    return model.mileAt(event.clientX - box.left);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const miles = timeline.checkpointMiles;
    if (miles.length === 0) return;
    const current = nearestCheckpoint(miles, cursorMile ?? truckMile ?? 0);
    let next: number | null = null;
    const step = KEY_STEPS[event.key];
    if (step !== undefined) {
      // Pressing an arrow with no cursor yet lands on the first checkpoint instead of skipping it.
      next = cursorMile == null ? current : Math.min(miles.length - 1, Math.max(0, current + step));
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = miles.length - 1;
    else if (event.key === "Escape" && cursorMile != null) {
      event.preventDefault();
      onCursor(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    onCursor(miles[next]);
  }

  const x0 = model.plotLeft;
  const x1 = model.plotRight;
  const bandId = `band-${uid}`;
  const haltId = `halt-${uid}`;
  const unknownId = `unknown-${uid}`;
  const cursorX = cursorMile == null ? null : model.x(cursorMile);
  const cursorPoint = readout && readout.checkpoint >= 0 ? model.windPoints.find((p) => p.index === readout.checkpoint) : undefined;
  const truckX = truckMile == null ? null : model.x(truckMile);
  const valueText = readout ? formatReadout(readout) : "No mile selected";

  return (
    <div
      ref={wrapRef}
      className="profile-chart"
      role="slider"
      tabIndex={0}
      aria-label={`Inspect weather along ${route.label}`}
      aria-describedby={`profile-summary-${uid}`}
      aria-valuemin={0}
      aria-valuemax={Math.round(route.distance_mi)}
      aria-valuenow={Math.round(cursorMile ?? 0)}
      aria-valuetext={valueText}
      data-testid="weather-profile"
      onPointerMove={(event) => onCursor(milesFromPointer(event))}
      onPointerDown={(event) => onCursor(milesFromPointer(event))}
      onPointerLeave={(event) => {
        // A finger that lifts keeps its mile; a mouse that leaves hands the map back.
        if (event.pointerType === "mouse") onCursor(null);
      }}
      onBlur={() => onCursor(null)}
      onKeyDown={onKeyDown}
    >
      <p id={`profile-summary-${uid}`} className="sr-only">
        {summary}
      </p>
      <svg width={width} height={model.height} viewBox={`0 0 ${width} ${model.height}`} aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={bandId}>
            <rect x={x0} y={model.band.top} width={Math.max(0, x1 - x0)} height={model.band.height} rx={3} />
          </clipPath>
          <pattern id={haltId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <rect width="5" height="5" fill="var(--halt)" />
            <rect width="2" height="5" fill="rgb(255 255 255 / 0.8)" />
          </pattern>
          <pattern id={unknownId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--unknown)" fillOpacity="0.35" />
            <rect width="1.5" height="5" fill="var(--unknown)" />
          </pattern>
        </defs>

        {/* Risk band: every checkpoint's owned miles in its level colour. */}
        <g clipPath={`url(#${bandId})`}>
          <rect x={x0} y={model.band.top} width={Math.max(0, x1 - x0)} height={model.band.height} fill="var(--track)" />
          {model.bands.map((band) => (
            <rect
              key={band.index}
              x={band.x}
              y={model.band.top}
              width={band.width + 0.5}
              height={model.band.height}
              fill={band.level === 4 ? `url(#${haltId})` : band.level == null ? `url(#${unknownId})` : riskColor(band.level)}
            />
          ))}
        </g>

        {/* Wind thresholds, each in the colour of the level it opens. */}
        {model.thresholds.map((item) => (
          <g key={item.mph}>
            <line
              x1={x0}
              x2={x1}
              y1={item.y}
              y2={item.y}
              stroke={riskColor(item.level)}
              strokeOpacity="0.55"
              strokeDasharray="2 4"
              shapeRendering="crispEdges"
            />
            <text className="profile-label" x={x0 + 1} y={item.y - 3}>
              {item.mph === 55 ? "55 mph" : item.mph}
            </text>
          </g>
        ))}
        <line
          x1={x0}
          x2={x1}
          y1={model.plot.bottom}
          y2={model.plot.bottom}
          stroke="var(--edge)"
          strokeOpacity="0.6"
          shapeRendering="crispEdges"
        />

        {model.windAreas.map((d) => (
          <path key={d} d={d} fill="var(--ink)" fillOpacity="0.07" />
        ))}
        {model.windLines.map((d) => (
          <path key={d} d={d} className="profile-wind" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* HOS stops on their own row, with a rule up through the wind plot. */}
        {model.breaks.map((item) => (
          <g key={`${item.kind}-${item.x}`} className="profile-stop">
            <line
              x1={item.x}
              x2={item.x}
              y1={model.plot.top}
              y2={model.stops.top}
              stroke="var(--muted)"
              strokeDasharray="1 3"
              shapeRendering="crispEdges"
            />
            <rect
              x={Math.min(Math.max(item.x - 17, x0), x1 - 34)}
              y={model.stops.top}
              width={34}
              height={model.stops.height}
              rx={7}
            />
            <text x={Math.min(Math.max(item.x, x0 + 17), x1 - 17)} y={model.stops.top + 10.5} textAnchor="middle">
              {item.kind === "rest" ? "10 h" : "30 min"}
            </text>
          </g>
        ))}

        {/* Precipitation, rain below snow, one bar per checkpoint. */}
        <line
          x1={x0}
          x2={x1}
          y1={model.precip.bottom}
          y2={model.precip.bottom}
          stroke="var(--edge)"
          strokeOpacity="0.6"
          shapeRendering="crispEdges"
        />
        {model.bars.map((bar) => (
          <g key={bar.index}>
            {bar.rainHeight > 0 && (
              <rect className="profile-rain" x={bar.x} y={model.precip.bottom - bar.rainHeight} width={bar.width} height={bar.rainHeight} />
            )}
            {bar.snowHeight > 0 && (
              <rect
                className="profile-snow"
                x={bar.x}
                y={model.precip.bottom - bar.rainHeight - bar.snowHeight}
                width={bar.width}
                height={bar.snowHeight}
              />
            )}
          </g>
        ))}
        <text className="profile-label" x={x0 + 1} y={model.precip.top + 8}>
          {`${model.precipMax.toFixed(model.precipMax < 1 ? 2 : 0)} in/hr`}
        </text>

        {/* Axis: mile and local ETA. */}
        {model.ticks.map((tick) => (
          <g key={tick.mile}>
            <line x1={tick.x} x2={tick.x} y1={model.precip.bottom} y2={model.precip.bottom + 4} stroke="var(--edge)" shapeRendering="crispEdges" />
            <text className="profile-tick" x={tick.x} y={model.axisTop + 10} textAnchor={tick.anchor}>
              {tick.top}
            </text>
            <text className="profile-tick profile-tick-time" x={tick.x} y={model.axisTop + 23} textAnchor={tick.anchor}>
              {tick.bottom}
            </text>
          </g>
        ))}

        {truckX != null && (
          <g className="profile-truck">
            <line x1={truckX} x2={truckX} y1={model.band.top} y2={model.precip.bottom} />
            <circle cx={truckX} cy={model.band.top + model.band.height / 2} r={5.5} />
          </g>
        )}
        {cursorX != null && (
          <g className="profile-cursor">
            <line x1={cursorX} x2={cursorX} y1={model.band.top} y2={model.precip.bottom} shapeRendering="crispEdges" />
            {cursorPoint && <circle cx={cursorPoint.x} cy={cursorPoint.y} r={4} />}
          </g>
        )}
      </svg>
    </div>
  );
}
