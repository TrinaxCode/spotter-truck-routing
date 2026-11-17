import { createPortal } from "react-dom";
import { useIsPhone } from "../hooks/useIsPhone";
import type { RouteOption } from "../api/types";
import { SPEEDS, TRIP_MINUTES_PER_SECOND, type PlaybackStatus, type Speed } from "../hooks/useTripPlayback";
import { lookAhead, progressGradient } from "../lib/drive";
import {
  formatDuration,
  formatInchesPerHour,
  formatMiles,
  formatShortClock,
  formatSpeedMph,
  formatTempF,
} from "../lib/format";
import { riskColor, riskLabel } from "../lib/riskColor";
import { timeAtMile, type Timeline, type TripSample } from "../lib/tripTimeline";

interface DriveHudProps {
  route: RouteOption;
  timeline: Timeline;
  status: PlaybackStatus;
  sample: TripSample | null;
  speed: Speed;
  following: boolean;
  reduceMotion: boolean;
  onStart: () => void;
  onToggle: () => void;
  onStop: () => void;
  onSpeed: (speed: Speed) => void;
  onFollow: (on: boolean) => void;
  /** Moves the truck to a trip instant (scrubbing the progress bar). */
  onSeek: (tMs: number) => void;
  /** Moves the truck by trip minutes; negative rewinds. */
  onSkip: (minutes: number) => void;
}

/**
 * Navigation-style heads-up display over the map while a trip plays (SPEC §12.3), and the
 * "Drive this route" call to action before it starts. Rendered into the map stage with a portal,
 * so it floats over the map while its state stays with the route's playback.
 */
export function DriveHud(props: DriveHudProps) {
  const phone = useIsPhone();
  // A phone's map is too small to carry a floating button; there it sits in the sheet, under the
  // recommendation. The running HUD always floats (the sheet folds away while driving).
  const idle = props.status === "idle" || !props.sample;
  const selector = phone && idle ? "#drive-slot" : ".map-stage";
  const target = typeof document === "undefined" ? null : document.querySelector(selector);
  if (!target) return null;
  return createPortal(<HudBody {...props} inline={phone && idle} />, target);
}

function HudBody({
  inline = false,
  route,
  timeline,
  status,
  sample,
  speed,
  following,
  reduceMotion,
  onStart,
  onToggle,
  onStop,
  onSpeed,
  onFollow,
  onSeek,
  onSkip,
}: DriveHudProps & { inline?: boolean }) {
  if (status === "idle" || !sample) {
    const overlay = inline ? {} : { "data-map-overlay": "", "data-overlay-edge": "top" };
    return (
      <div className={inline ? "drive-cta drive-cta-inline" : "drive-cta"} {...overlay}>
        <button type="button" className="drive-cta-btn" onClick={onStart} data-testid="drive-start">
          <TruckGlyph />
          <span className="drive-cta-text">
            <strong>Drive {route.label}</strong>
            <small>
              {formatMiles(route.distance_mi)} · {formatDuration(route.total_time_s)} with breaks
            </small>
          </span>
          <span className="drive-cta-go" aria-hidden="true">
            ▶
          </span>
        </button>
      </div>
    );
  }

  const checkpoint = route.checkpoints[sample.checkpoint];
  const weather = checkpoint?.weather ?? null;
  const ahead = lookAhead(route, timeline, sample);
  const playing = status === "playing";
  const remaining = Math.max(0, timeline.distanceMi - sample.mile);

  return (
    <section
      className="drive-hud"
      aria-label={`Driving ${route.label}`}
      data-map-overlay=""
      data-overlay-edge="top"
      data-testid="drive-hud"
    >
      <div className="hud-top">
        <div className="hud-clock">
          <span className="hud-time">{formatShortClock(new Date(sample.tMs).toISOString())}</span>
          <span className="hud-sub">
            Mile {Math.round(sample.mile).toLocaleString("en-US")} · {formatMiles(remaining)} to go
          </span>
        </div>
        <div className="hud-weather" aria-label="Weather at the truck">
          <span className="hud-level" style={{ "--c": riskColor(checkpoint?.level) } as React.CSSProperties}>
            {riskLabel(checkpoint?.level)}
          </span>
          {weather ? (
            <>
              <HudStat
                label="Wind"
                value={formatSpeedMph(weather.wind_mph)}
                hint={`gust ${formatSpeedMph(weather.gust_mph)}`}
              />
              <HudStat label="Rain" value={formatInchesPerHour(weather.rain_in_hr)} />
              <HudStat label="Snow" value={formatInchesPerHour(weather.snow_in_hr)} />
              <HudStat label="Temp" value={formatTempF(weather.temp_f)} />
            </>
          ) : (
            <span className="hud-sub">Forecast unavailable here</span>
          )}
        </div>
      </div>
      <div className="hud-progress">
        <div className="hud-bar" aria-hidden="true" style={{ backgroundImage: progressGradient(route, timeline) }} />
        <div
          className="hud-truck"
          aria-hidden="true"
          style={{
            left: `${Math.min(100, (sample.mile / Math.max(timeline.distanceMi, 1e-6)) * 100)}%`,
          }}
        />
        {/* Mile-based, like the risk bar under it; dragging back rewinds the trip. */}
        <input
          type="range"
          className="hud-scrub"
          data-testid="hud-scrub"
          aria-label="Trip position"
          aria-valuetext={`Mile ${Math.round(sample.mile)}, ${formatShortClock(new Date(sample.tMs).toISOString())}`}
          min={0}
          max={timeline.distanceMi}
          step={Math.max(timeline.distanceMi / 400, 0.1)}
          value={sample.mile}
          onChange={(event) => onSeek(timeAtMile(timeline, Number(event.currentTarget.value)))}
        />
      </div>
      <div className="hud-foot">
        <p
          className="hud-ahead"
          data-tone={ahead.tone}
          style={{ "--c": riskColor(ahead.level) } as React.CSSProperties}
        >
          {ahead.text}
        </p>
        <div className="hud-actions">
          <button type="button" className="hud-btn hud-skip" onClick={() => onSkip(-60)} aria-label="Back one trip hour" title="Back 1 h">
            −1h
          </button>
          <button type="button" className="hud-btn hud-skip" onClick={() => onSkip(60)} aria-label="Forward one trip hour" title="Forward 1 h">
            +1h
          </button>
          {!reduceMotion && (
            <button
              type="button"
              className="hud-btn"
              onClick={onToggle}
              aria-label={playing ? "Pause trip" : "Resume trip"}
            >
              {playing ? "❚❚" : "▶"}
            </button>
          )}
          {!reduceMotion && (
            <div className="hud-speed" role="radiogroup" aria-label="Playback speed">
              {SPEEDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={speed === value}
                    aria-label={`${value}x speed, ${value * TRIP_MINUTES_PER_SECOND} trip minutes per second`}
                  onClick={() => onSpeed(value)}
                >
                  {value}×
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="hud-btn hud-follow"
            aria-pressed={following}
            onClick={() => onFollow(!following)}
            title={following ? "Show the whole map" : "Follow the truck"}
          >
            {following ? "Overview" : "Follow"}
          </button>
          <button type="button" className="hud-btn" onClick={onStop} aria-label="Stop trip">
            ✕
          </button>
        </div>
      </div>
    </section>
  );
}

function HudStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <span className="hud-stat">
      <span className="hud-stat-value">{value}</span>
      <span className="hud-stat-label">{hint ? `${label} · ${hint}` : label}</span>
    </span>
  );
}

function TruckGlyph() {
  return (
    <svg width="34" height="22" viewBox="0 0 34 22" aria-hidden="true" className="drive-cta-icon">
      <rect x="1" y="3" width="19" height="12" rx="1.6" fill="currentColor" opacity="0.92" />
      <path d="M21 6h6.2l4.3 4.6V15H21z" fill="currentColor" />
      <path d="M23 7.6h3.6l2.6 2.8H23z" fill="var(--on-accent)" opacity="0.55" />
      <circle cx="7" cy="17" r="2.6" fill="currentColor" stroke="var(--on-accent)" strokeWidth="1.4" />
      <circle cx="14" cy="17" r="2.6" fill="currentColor" stroke="var(--on-accent)" strokeWidth="1.4" />
      <circle cx="27" cy="17" r="2.6" fill="currentColor" stroke="var(--on-accent)" strokeWidth="1.4" />
    </svg>
  );
}
