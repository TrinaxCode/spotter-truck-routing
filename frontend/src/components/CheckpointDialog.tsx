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

  return (
    <div
      className="checkpoint-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby="checkpoint-title"
      data-testid="checkpoint-dialog"
    >
      <div className="dialog-head">
        <h2 id="checkpoint-title">
          {route.label}, {formatMiles(checkpoint.mile)}
        </h2>
        <button ref={closeRef} type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p>ETA {formatClock(checkpoint.eta)}</p>
      <p className="level-line">
        Level: {checkpoint.level_label || riskLabel(checkpoint.level)}
      </p>
      {weather ? (
        <dl className="wx">
          <div>
            <dt>Wind</dt>
            <dd>{formatSpeedMph(weather.wind_mph)}</dd>
          </div>
          <div>
            <dt>Gust</dt>
            <dd>{formatSpeedMph(weather.gust_mph)}</dd>
          </div>
          <div>
            <dt>Rain</dt>
            <dd>{formatInchesPerHour(weather.rain_in_hr)}</dd>
          </div>
          <div>
            <dt>Snow</dt>
            <dd>{formatInchesPerHour(weather.snow_in_hr)}</dd>
          </div>
          <div>
            <dt>Temp</dt>
            <dd>{formatTempF(weather.temp_f)}</dd>
          </div>
        </dl>
      ) : (
        <p>Weather is missing for this checkpoint. It is excluded from the average.</p>
      )}
      {checkpoint.reasons.length > 0 ? (
        <ul className="reasons">
          {checkpoint.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : (
        <p>No elevated risk at this checkpoint.</p>
      )}
    </div>
  );
}
