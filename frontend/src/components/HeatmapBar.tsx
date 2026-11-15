import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { HeatVariable } from "../api/types";
import { forecastTicks, formatFrameOffset, formatFrameTime } from "../lib/format";
import { onRadioKeyDown } from "../lib/radio";
import { Legend } from "./States";

const VARIABLES: { id: HeatVariable; label: string }[] = [
  { id: "risk", label: "Risk" },
  { id: "wind", label: "Wind" },
  { id: "rain", label: "Rain" },
  { id: "snow", label: "Snow" },
];

interface HeatmapBarProps {
  startIso: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  onRetry: () => void;
  onFrame: (hour: number, variable: HeatVariable, visible: boolean) => void;
}

export function HeatmapBar({ startIso, status, error, onRetry, onFrame }: HeatmapBarProps) {
  const [hour, setHour] = useState(0);
  const [variable, setVariable] = useState<HeatVariable>("risk");
  const [visible, setVisible] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const hourRef = useRef(0);
  const variableRef = useRef<HeatVariable>("risk");
  const visibleRef = useRef(true);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Publish the card's height so floating panels can stop above it on narrow screens.
  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const publish = () => document.documentElement.style.setProperty("--time-h", `${node.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(media.matches);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!startIso || status !== "ready") return;
    onFrame(hourRef.current, variableRef.current, visibleRef.current);
  }, [startIso, status, onFrame]);

  useEffect(() => {
    if (!playing || reduceMotion) return;
    const timer = window.setInterval(() => {
      if (hourRef.current >= 48) {
        setPlaying(false);
        return;
      }
      const next = hourRef.current + 1;
      hourRef.current = next;
      setHour(next);
      onFrame(next, variableRef.current, visibleRef.current);
    }, 700);
    return () => window.clearInterval(timer);
  }, [playing, reduceMotion, onFrame]);

  function push(nextHour: number, nextVariable: HeatVariable, nextVisible: boolean) {
    hourRef.current = nextHour;
    variableRef.current = nextVariable;
    visibleRef.current = nextVisible;
    setHour(nextHour);
    setVariable(nextVariable);
    setVisible(nextVisible);
    onFrame(nextHour, nextVariable, nextVisible);
  }

  const ready = status === "ready" && !!startIso;
  const time = startIso ? formatFrameTime(startIso, hour) : "";
  const offset = formatFrameOffset(hour);
  const label = `${time}, ${offset}`;
  const ticks = startIso ? forecastTicks(startIso) : [];
  const style = { "--p": hour / 48 } as CSSProperties;

  return (
    <div ref={wrapRef} className="time-wrap" data-map-overlay="" data-overlay-edge="bottom">
      <Legend variable={variable} visible={visible} />
      <section className="timeline" aria-label="Corridor forecast" aria-busy={status === "loading"} data-state={status}>
        <button
          type="button"
          className="play"
          aria-pressed={playing}
          aria-label={playing ? "Pause forecast" : "Play forecast"}
          disabled={!ready || reduceMotion}
          onClick={() => {
            // Pressing play on the last frame starts over instead of stopping at once.
            if (!playing && hourRef.current >= 48) push(0, variableRef.current, visibleRef.current);
            setPlaying((current) => !current);
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="clock" data-testid="forecast-clock">
          {status === "ready" && (
            <>
              <p className="clock-time">{time}</p>
              <p className="clock-offset">{reduceMotion ? `${offset}. Use the arrow keys to step.` : offset}</p>
            </>
          )}
          {status === "loading" && (
            <>
              <p className="clock-time clock-quiet">Loading forecast</p>
              <p className="clock-offset">Fetching 48 hours along your corridor…</p>
            </>
          )}
          {status === "idle" && (
            <>
              <p className="clock-time clock-quiet">48-hour forecast</p>
              <p className="clock-offset">Plan a trip to load wind, rain and snow along the route.</p>
            </>
          )}
          {status === "error" && (
            <>
              <p className="clock-time clock-quiet">Forecast unavailable</p>
              <p className="clock-offset">{error || "The forecast did not load."}</p>
            </>
          )}
        </div>
        <div className="tools">
          <div role="radiogroup" aria-label="Forecast variable" className="chips">
            {VARIABLES.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={variable === item.id}
                tabIndex={variable === item.id ? 0 : -1}
                onClick={() => push(hourRef.current, item.id, visibleRef.current)}
                onKeyDown={(event) =>
                  onRadioKeyDown(event, index, VARIABLES.length, (next) =>
                    push(hourRef.current, VARIABLES[next].id, visibleRef.current),
                  )
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          {status === "error" ? (
            <button type="button" className="text-btn" onClick={onRetry}>
              Retry forecast
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              aria-pressed={visible}
              aria-label="Show heatmap"
              title={visible ? "Hide heatmap" : "Show heatmap"}
              onClick={() => push(hourRef.current, variableRef.current, !visibleRef.current)}
            >
              <HeatIcon />
            </button>
          )}
        </div>
        <span className="sr-only" role="status">
          {status === "loading" && "Loading corridor forecast"}
          {status === "error" && (error || "The forecast did not load.")}
          {status === "ready" && "Corridor forecast ready"}
        </span>
        <div className="slider" style={style}>
          <input
            id="forecast-hour"
            data-testid="heatmap-slider"
            type="range"
            min={0}
            max={48}
            step={1}
            value={hour}
            disabled={!ready}
            aria-label="Forecast hour"
            aria-valuemin={0}
            aria-valuemax={48}
            aria-valuenow={hour}
            aria-valuetext={ready ? label : "Forecast unavailable"}
            onChange={(event) => {
              setPlaying(false);
              push(Number(event.target.value), variableRef.current, visibleRef.current);
            }}
          />
          <div className="ticks" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.hour}
                className={tick.day ? "tick tick-day" : "tick"}
                style={{ "--at": tick.hour / 48 } as CSSProperties}
              >
                <span className="tick-day-name">{tick.day ?? ""}</span>
                <span className="tick-time">{tick.time}</span>
              </span>
            ))}
            {/* Before a plan there is no clock yet; the scale still shows how far the forecast reaches. */}
            {ticks.length === 0 &&
              [0, 12, 24, 36, 48].map((offsetHours) => (
                <span key={offsetHours} className="tick" style={{ "--at": offsetHours / 48 } as CSSProperties}>
                  <span className="tick-day-name" />
                  <span className="tick-time">{offsetHours === 0 ? "Start" : `+${offsetHours} h`}</span>
                </span>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function HeatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1.5" y="1.5" width="6" height="6" rx="1.5" fill="currentColor" />
      <rect x="10.5" y="1.5" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.4" />
      <rect x="1.5" y="10.5" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.4" />
      <rect x="10.5" y="10.5" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.75" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 2.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L5.4 2.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" />
      <rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}
