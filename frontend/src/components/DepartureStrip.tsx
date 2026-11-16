import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DepartureOptionsResponse } from "../api/types";
import { AXIS_LOCK_PX, indexAt, useAxisClaim } from "../hooks/useSwipe";
import { isDepartingNow, stayLabel, stripBars, stripSummary } from "../lib/departure";
import { forecastTicks } from "../lib/format";
import { onRadioKeyDown } from "../lib/radio";

export type DepartureStatus = "idle" | "loading" | "ready" | "error";

interface DepartureStripProps {
  status: DepartureStatus;
  data: DepartureOptionsResponse | null;
  error?: string;
  /** Route id to display label ("r1" to "Route A"). */
  labelOf: (routeId: string) => string;
  /** When the plan was made, to tell "now" from a planned time. */
  generatedAt: string;
  onRetry: () => void;
  /** Re-plan the same trip leaving at this instant (ISO, UTC). */
  onApply: (departureIso: string) => void;
}

/**
 * "Best time to leave" (SPEC §12.1): the next 24 hours of departures as one bar each. Colour is the
 * worst level on that departure's best route, height is its High-or-worse miles. The bars are a
 * radio group so the keyboard walks them; the picked one can be applied, as can the suggestion.
 */
export function DepartureStrip({ status, data, error, labelOf, generatedAt, onRetry, onApply }: DepartureStripProps) {
  return (
    <section className="depart" aria-label="Best time to leave" aria-busy={status === "loading"} data-state={status}>
      <h2 className="section-title">Best time to leave</h2>
      {status === "loading" && (
        <div className="depart-skeleton" role="status">
          <span className="sr-only">Checking the next 24 hours of departures</span>
          <span className="sk depart-sk-line" />
          <span className="sk depart-sk-bars" />
        </div>
      )}
      {status === "error" && (
        <p className="depart-error" role="status">
          {error || "Departure options did not load."}{" "}
          <button type="button" className="text-btn" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
      {status === "ready" && data && (
        <ReadyStrip data={data} labelOf={labelOf} generatedAt={generatedAt} onApply={onApply} />
      )}
    </section>
  );
}

function ReadyStrip({
  data,
  labelOf,
  generatedAt,
  onApply,
}: Pick<DepartureStripProps, "labelOf" | "generatedAt" | "onApply"> & { data: DepartureOptionsResponse }) {
  const bars = useMemo(() => stripBars(data, labelOf), [data, labelOf]);
  const ticks = useMemo(() => forecastTicks(data.base_departure, 24, 6), [data.base_departure]);
  const summaryId = useId();
  const [picked, setPicked] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const suggestion = data.suggestion;
  const shown = bars[hover ?? picked] ?? bars[0];
  const pickedBar = bars[picked];
  const slots = Math.max(1, bars.length);
  const barsRef = useRef(bars);
  const scrubbing = useRef(false);
  useEffect(() => {
    barsRef.current = bars;
  });
  // Press-and-drag across the row. A vertical move stays a scroll (touch-action: pan-y).
  const stripRef = useAxisClaim<HTMLDivElement>({
    claim: "x",
    swallowAt: AXIS_LOCK_PX,
    onClaim: () => {
      scrubbing.current = true;
    },
    onMove: ({ event }) => {
      const node = stripRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const index = indexAt(event.clientX, rect.left, rect.width, barsRef.current.length);
      setPicked(index);
      setHover(index);
    },
    onEnd: () => {
      scrubbing.current = false;
      setHover(null);
    },
    onCancel: () => {
      scrubbing.current = false;
      setHover(null);
    },
  });

  return (
    <>
      {suggestion ? (
        <div className="callout depart-callout" data-tone="good" data-testid="departure-suggestion">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10 5.6V10l3 1.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="depart-copy">
            <p className="callout-lead">{suggestion.headline}</p>
            <button
              type="button"
              className="apply-btn"
              data-testid="apply-suggestion"
              onClick={() => onApply(suggestion.departure)}
            >
              Apply
              <span className="sr-only">{`: leave ${bars.find((bar) => bar.offset === suggestion.offset_h)?.timeLabel ?? `${suggestion.offset_h} hours later`}`}</span>
            </button>
          </div>
        </div>
      ) : (
        <p className="depart-stay" data-testid="departure-stay">
          <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="m6.3 10.3 2.4 2.4 5-5.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {stayLabel(data.base_departure, generatedAt)}
        </p>
      )}

      <p id={summaryId} className="sr-only">
        {stripSummary(bars)}
      </p>
      <div className="strip-wrap">
        <div
          ref={stripRef}
          className="strip"
          role="radiogroup"
          aria-label="Departure time, next 24 hours"
          aria-describedby={summaryId}
          style={{ "--slots": slots } as CSSProperties}
          onPointerLeave={() => {
            if (scrubbing.current) return;
            setHover(null);
          }}
        >
          {bars.map((bar, index) => {
            const suggested = suggestion?.offset_h === bar.offset;
            return (
              <button
                key={bar.offset}
                type="button"
                role="radio"
                className="strip-bar"
                aria-checked={picked === index}
                tabIndex={picked === index ? 0 : -1}
                aria-label={suggested ? `${bar.text} · suggested` : bar.text}
                title={bar.text}
                data-testid="departure-bar"
                data-offset={bar.offset}
                data-level={bar.level ?? "unknown"}
                data-partial={bar.partial}
                data-suggested={suggested}
                onClick={() => setPicked(index)}
                onPointerEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                onBlur={() => setHover(null)}
                onKeyDown={(event) => onRadioKeyDown(event, index, bars.length, setPicked)}
              >
                <span className="strip-fill" style={{ "--h": bar.height, "--c": bar.color } as CSSProperties} />
              </button>
            );
          })}
        </div>
        <div className="strip-ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.hour}
              className="strip-tick"
              style={{ "--at": (tick.hour + 0.5) / slots } as CSSProperties}
            >
              {tick.hour === 0 && isDepartingNow(data.base_departure, generatedAt)
                ? "Now"
                : tick.day ? `${tick.day} ${tick.time}` : tick.time}
            </span>
          ))}
        </div>
        <div className="strip-detail" data-testid="departure-detail">
          <p>{shown?.text}</p>
          {pickedBar && pickedBar.offset !== 0 && (
            <button
              type="button"
              className="text-btn"
              data-testid="apply-picked"
              onClick={() => onApply(pickedBar.departure)}
            >
              Plan for {pickedBar.timeLabel}
            </button>
          )}
        </div>
        <p className="strip-caption" aria-hidden="true">
          Colour is the worst level on the best route. Height is its High-or-worse miles.
        </p>
      </div>
    </>
  );
}
