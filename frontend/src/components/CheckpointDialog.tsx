import { useEffect, useRef } from "react";
import type { Checkpoint, RouteOption } from "../api/types";
import { formatClock, formatInchesPerHour, formatMiles, formatSpeedMph, formatTempF } from "../lib/format";
import { riskLabel } from "../lib/riskColor";

interface CheckpointDialogProps {
  route: RouteOption;
  checkpoint: Checkpoint;
  onClose: () => void;
}

export function CheckpointDialog({ route, checkpoint, onClose }: CheckpointDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const weather = checkpoint.weather;
  const label = checkpoint.level_label || riskLabel(checkpoint.level);

  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous.current?.focus();
    };
  }, [onClose, checkpoint.index, route.id]);

  const readings = weather
    ? [
        { name: "Wind", value: formatSpeedMph(weather.wind_mph) },
        { name: "Gust", value: formatSpeedMph(weather.gust_mph) },
        { name: "Rain", value: formatInchesPerHour(weather.rain_in_hr) },
        { name: "Snow", value: formatInchesPerHour(weather.snow_in_hr) },
        { name: "Temp", value: formatTempF(weather.temp_f) },
      ]
    : [];

  return (
    <div
      className="checkpoint-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby="checkpoint-title"
      data-testid="checkpoint-dialog"
    >
      <div className="dialog-head">
        <div>
          <h2 id="checkpoint-title">
            {route.label}, {formatMiles(checkpoint.mile)}
          </h2>
          <p className="dialog-eta">ETA {formatClock(checkpoint.eta)}</p>
        </div>
        <span className="pill" data-level={checkpoint.level ?? "unknown"}>
          <span className="sr-only">Level: </span>
          {label}
        </span>
        <button ref={closeRef} type="button" className="close-btn" aria-label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m3.5 3.5 9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {weather ? (
        <dl className="wx">
          {readings.map((reading) => (
            <div key={reading.name}>
              <dt>{reading.name}</dt>
              <dd>{reading.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="dialog-note">Weather is missing for this checkpoint. It is excluded from the average.</p>
      )}
      {checkpoint.reasons.length > 0 ? (
        <ul className="reasons">
          {checkpoint.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : (
        <p className="dialog-note">No elevated risk at this checkpoint.</p>
      )}
    </div>
  );
}
