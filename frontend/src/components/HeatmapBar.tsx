import { useEffect, useRef, useState } from "react";
import type { HeatVariable } from "../api/types";
import { forecastTicks, formatFrameLabel } from "../lib/format";

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

  const label = startIso ? formatFrameLabel(startIso, hour) : "Plan a trip to load the forecast";
  const ready = status === "ready" && !!startIso;
  const ticks = startIso ? forecastTicks(startIso) : [];

  return (
    <section className="timeline" aria-label="Corridor forecast">
      <div className="timeline-top">
        <h2>Forecast</h2>
        <p className="clock" data-testid="forecast-clock">
          {status === "loading" && "Loading corridor forecast…"}
          {status === "error" && (error || "The forecast did not load.")}
          {status === "idle" && "Plan a trip to load the 49-hour corridor."}
          {status === "ready" && label}
        </p>
        {status === "error" && (
          <button type="button" onClick={onRetry}>
            Retry forecast
          </button>
        )}
      </div>
      <div className="timeline-controls">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={visible}
          aria-label={visible ? "Hide heatmap" : "Show heatmap"}
          onClick={() => push(hourRef.current, variableRef.current, !visibleRef.current)}
        >
          <HeatIcon />
        </button>
        <div role="radiogroup" aria-label="Forecast variable" className="segment-row">
          {VARIABLES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={variable === item.id}
              onClick={() => push(hourRef.current, item.id, visibleRef.current)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-pressed={playing}
          aria-label={playing ? "Pause forecast" : "Play forecast"}
          disabled={!ready || reduceMotion}
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
      </div>
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
      {ticks.length > 0 && (
        <div className="ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.hour} className={tick.day ? "tick tick-day" : "tick"}>
              {tick.day ? <span className="tick-weekday">{tick.day}</span> : <span className="tick-weekday" />}
              <span>{tick.time}</span>
            </span>
          ))}
        </div>
      )}
      {reduceMotion && <p className="field-hint">Motion is reduced. Use the arrow keys to step the forecast.</p>}
    </section>
  );
}

function HeatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1" y="1" width="6" height="6" fill="currentColor" />
      <rect x="11" y="1" width="6" height="6" fill="currentColor" opacity="0.45" />
      <rect x="1" y="11" width="6" height="6" fill="currentColor" opacity="0.45" />
      <rect x="11" y="11" width="6" height="6" fill="currentColor" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2.5v11l10-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2h3.5v12H3zm6.5 0H13v12H9.5z" fill="currentColor" />
    </svg>
  );
}
