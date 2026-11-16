import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RouteOption } from "../api/types";
import { SPEEDS, useTripPlayback, type Speed } from "../hooks/useTripPlayback";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { formatReadout, readoutAtMile } from "../lib/profile";
import { buildTimeline, nearestCheckpoint, type TripSample } from "../lib/tripTimeline";
import { onRadioKeyDown } from "../lib/radio";
import { DriveHud } from "./DriveHud";
import { DRIVE_TOGGLE_EVENT } from "../lib/shortcuts";
import { WeatherProfile } from "./WeatherProfile";

interface TripProfileProps {
  route: RouteOption;
  /** Heatmap frame 0 (ISO) once the forecast has loaded. */
  heatStartIso: string | null;
  onTruck: (sample: TripSample | null) => void;
  onHour: (hour: number | null) => void;
  onPlaying: (playing: boolean) => void;
  /** Checkpoint under the profile cursor, for the ring on the map; null clears it. */
  onFocusCheckpoint: (routeId: string, index: number | null) => void;
  /** Chase camera state, reported by the map. */
  following: boolean;
  onFollow: (on: boolean) => void;
}

/**
 * Everything about the selected route's journey: the weather profile (SPEC §12.2) and the trip
 * playback (SPEC §12.3). Keyed by route in the parent, so a route change unmounts it, which stops
 * the animation loop and removes the truck.
 */
export function TripProfile({
  route,
  heatStartIso,
  onTruck,
  onHour,
  onPlaying,
  onFocusCheckpoint,
  following,
  onFollow,
}: TripProfileProps) {
  const timeline = useMemo(() => buildTimeline(route), [route]);
  const reduceMotion = useReducedMotion();
  const playback = useTripPlayback({ timeline, heatStartIso, reduceMotion, onTruck, onHour, onPlaying });
  const { status, sample } = playback;
  const [cursorMile, setCursorMile] = useState<number | null>(null);
  const focused = useRef<number | null>(null);

  const moveCursor = useCallback(
    (mile: number | null) => {
      setCursorMile(mile);
      const index = mile == null ? null : nearestCheckpoint(timeline.checkpointMiles, mile);
      const checkpoint = index != null && index >= 0 ? route.checkpoints[index].index : null;
      if (checkpoint === focused.current) return;
      focused.current = checkpoint;
      onFocusCheckpoint(route.id, checkpoint);
    },
    [route, timeline, onFocusCheckpoint],
  );

  // The "D" shortcut drives (or pauses) the selected route without a handle on this component.
  const playbackRef = useRef(playback);
  useEffect(() => {
    playbackRef.current = playback;
  });
  useEffect(() => {
    const onDrive = () => {
      const current = playbackRef.current;
      if (reduceMotion) current.step(1);
      else if (current.status === "playing") current.pause();
      else current.play();
    };
    window.addEventListener(DRIVE_TOGGLE_EVENT, onDrive);
    return () => window.removeEventListener(DRIVE_TOGGLE_EVENT, onDrive);
  }, [reduceMotion]);

  // Leaving the route removes the ring from the map along with the chart.
  useEffect(() => {
    const routeId = route.id;
    return () => {
      if (focused.current !== null) onFocusCheckpoint(routeId, null);
    };
  }, [route.id, onFocusCheckpoint]);

  const active = status !== "idle" && sample != null;
  const truckReadout = active ? readoutAtMile(route, timeline, sample.mile, sample.tMs) : null;
  const cursorReadout = cursorMile == null ? null : readoutAtMile(route, timeline, cursorMile);
  const line = cursorReadout ? formatReadout(cursorReadout) : truckReadout ? formatReadout(truckReadout) : null;
  const stop = active ? sample.stop : null;

  const playing = status === "playing";
  const announce = stop
    ? `${stop.label} at mile ${Math.round(stop.mile)}`
    : status === "finished"
      ? "Trip finished"
      : status === "playing"
        ? "Playing trip"
        : status === "paused"
          ? "Trip paused"
          : "";

  return (
    <section className="trip" aria-label={`Weather and trip along ${route.label}`} data-testid="trip-profile">
      <DriveHud
        route={route}
        timeline={timeline}
        status={status}
        sample={sample}
        speed={playback.speed}
        following={following}
        reduceMotion={reduceMotion}
        onStart={() => (reduceMotion ? playback.step(1) : playback.play())}
        onToggle={() => (playing ? playback.pause() : playback.play())}
        onStop={playback.stop}
        onSpeed={playback.setSpeed}
        onFollow={onFollow}
      />
      <h2 className="section-title">Along {route.label}</h2>
      <div className="trip-card">
        <div className="trip-controls">
          {reduceMotion ? (
            <div className="stepper" role="group" aria-label="Step through the trip">
              <button type="button" className="step-btn" onClick={() => playback.step(-1)} disabled={playback.stepIndex <= 0}>
                Previous checkpoint
              </button>
              <button
                type="button"
                className="step-btn step-btn-main"
                onClick={() => playback.step(1)}
                disabled={playback.stepIndex >= timeline.checkpointMs.length - 1}
              >
                {playback.stepIndex < 0 ? "Start trip" : "Next checkpoint"}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="trip-play"
                data-testid="trip-play"
                aria-pressed={playing}
                onClick={() => (playing ? playback.pause() : playback.play())}
              >
                {playing ? <PauseGlyph /> : <PlayGlyph />}
                <span>{playing ? "Pause trip" : status === "paused" ? "Resume trip" : status === "finished" ? "Replay trip" : "Play trip"}</span>
              </button>
              <div role="radiogroup" aria-label="Playback speed" className="chips trip-speed">
                {SPEEDS.map((value, index) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={playback.speed === value}
                    tabIndex={playback.speed === value ? 0 : -1}
                    aria-label={`${value}x speed, ${value} trip ${value === 1 ? "hour" : "hours"} per second`}
                    onClick={() => playback.setSpeed(value)}
                    onKeyDown={(event) =>
                      onRadioKeyDown(event, index, SPEEDS.length, (next) => playback.setSpeed(SPEEDS[next] as Speed))
                    }
                  >
                    {value}×
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="trip-readout" data-testid="trip-readout" data-active={active} data-cursor={cursorMile != null}>
          {line ? (
            <>
              <p className="readout-line">{line}</p>
              {stop && !cursorReadout && (
                <span className="stop-badge" data-kind={stop.kind} data-testid="stop-badge">
                  {stop.label}
                </span>
              )}
            </>
          ) : (
            <p className="readout-hint">
              {reduceMotion
                ? "Step through the trip checkpoint by checkpoint, or inspect any mile on the chart."
                : "Play the trip, or move along the chart to inspect any mile."}
            </p>
          )}
          {status !== "idle" && (
            <button type="button" className="text-btn trip-stop" onClick={playback.stop}>
              Stop
            </button>
          )}
        </div>
        <p className="sr-only" role="status">
          {announce}
        </p>

        <WeatherProfile
          route={route}
          timeline={timeline}
          truckMile={active ? sample.mile : null}
          cursorMile={cursorMile}
          onCursor={moveCursor}
        />
        <ul className="profile-key" aria-label="Chart key">
          <li>
            <span className="key-line" aria-hidden="true" />
            Wind
          </li>
          <li>
            <span className="key-swatch key-rain" aria-hidden="true" />
            Rain
          </li>
          <li>
            <span className="key-swatch key-snow" aria-hidden="true" />
            Snow
          </li>
          <li>
            <span className="key-tab" aria-hidden="true" />
            HOS stop
          </li>
        </ul>
      </div>
    </section>
  );
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 2.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L5.4 2.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" />
      <rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}
