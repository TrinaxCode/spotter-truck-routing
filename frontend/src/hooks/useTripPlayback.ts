import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { frameHour, sampleTimeline, type Timeline, type TripSample } from "../lib/tripTimeline";

export type PlaybackStatus = "idle" | "playing" | "paused" | "finished";

/** Trip hours that pass per real second at 1x (SPEC §12.3). */
export const TRIP_HOURS_PER_SECOND = 1;
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** A tab that was in the background must not make the truck leap: cap one step at 100 ms. */
const MAX_STEP_MS = 100;
/** React state (readout, chart marker) refreshes at about this interval; the map moves every frame. */
const VIEW_INTERVAL_MS = 66;

interface Options {
  timeline: Timeline;
  /** Heatmap frame 0 (ISO). Until the forecast loads, the departure hour stands in. */
  heatStartIso: string | null;
  reduceMotion: boolean;
  /** Called every animation frame with the truck; null removes it. */
  onTruck: (sample: TripSample | null) => void;
  /** Called when the truck's forecast hour changes; null when playback ends. */
  onHour: (hour: number | null) => void;
  /** True while the animation runs, so the forecast slider can step aside. */
  onPlaying: (playing: boolean) => void;
}

export interface TripPlayback {
  status: PlaybackStatus;
  speed: Speed;
  setSpeed: (speed: Speed) => void;
  /** Latest truck state for the readout; refreshed about 15 times a second while playing. */
  sample: TripSample | null;
  /** Index of the checkpoint the stepper stands on, or -1. */
  stepIndex: number;
  play: () => void;
  pause: () => void;
  /** Removes the truck and hands the forecast slider back. */
  stop: () => void;
  /** Reduced motion: jump to the previous (-1) or next (1) checkpoint. */
  step: (direction: -1 | 1) => void;
}

/**
 * Trip playback (SPEC §12.3). One requestAnimationFrame loop advances trip time, asks the timeline
 * where the truck is, and reports it. Nothing here touches React state per frame except the
 * throttled `sample`; the map receives the truck through `onTruck` and the heatmap hour through
 * `onHour` only when the hour changes. The loop and the truck are torn down on unmount and whenever
 * the timeline (route) changes.
 */
export function useTripPlayback(options: Options): TripPlayback {
  const { timeline, reduceMotion } = options;
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [speed, setSpeedState] = useState<Speed>(1);
  const [sample, setSample] = useState<TripSample | null>(null);
  const [stepIndex, setStepIndex] = useState(-1);

  const callbacks = useRef(options);
  const timelineRef = useRef(timeline);
  const statusRef = useRef<PlaybackStatus>("idle");
  const speedRef = useRef<Speed>(1);
  const tRef = useRef(timeline.startMs);
  const frameRef = useRef(0);
  const lastRef = useRef(0);
  const viewAtRef = useRef(0);
  const hourRef = useRef<number | null>(null);
  const stepRef = useRef(-1);

  useLayoutEffect(() => {
    callbacks.current = options;
    timelineRef.current = timeline;
  });

  const changeStatus = useCallback((next: PlaybackStatus) => {
    statusRef.current = next;
    setStatus(next);
    callbacks.current.onPlaying(next === "playing");
  }, []);

  const cancel = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  /** Places the truck at tRef and tells the map, the heatmap and (throttled) the readout. */
  const publish = useCallback((force: boolean, now: number) => {
    const line = timelineRef.current;
    const next = sampleTimeline(line, tRef.current);
    const { onTruck, onHour, heatStartIso } = callbacks.current;
    onTruck(next);
    const start = Date.parse(heatStartIso ?? new Date(Math.floor(line.startMs / 3_600_000) * 3_600_000).toISOString());
    const hour = frameHour(start, next.tMs);
    if (hour !== hourRef.current) {
      hourRef.current = hour;
      onHour(hour);
    }
    if (force || now - viewAtRef.current >= VIEW_INTERVAL_MS) {
      viewAtRef.current = now;
      setSample(next);
    }
    return next;
  }, []);

  const tickRef = useRef<(now: number) => void>(() => undefined);
  const tick = useCallback(
    (now: number) => {
      frameRef.current = 0;
      if (statusRef.current !== "playing") return;
      const line = timelineRef.current;
      const elapsed = Math.min(now - lastRef.current, MAX_STEP_MS);
      lastRef.current = now;
      tRef.current += elapsed * speedRef.current * TRIP_HOURS_PER_SECOND * 3600;
      if (tRef.current >= line.endMs) {
        tRef.current = line.endMs;
        publish(true, now);
        changeStatus("finished");
        return;
      }
      publish(false, now);
      frameRef.current = requestAnimationFrame((next) => tickRef.current(next));
    },
    [publish, changeStatus],
  );
  useLayoutEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const play = useCallback(() => {
    if (reduceMotion) return;
    const line = timelineRef.current;
    if (statusRef.current === "idle" || statusRef.current === "finished" || tRef.current >= line.endMs) {
      tRef.current = line.startMs;
      hourRef.current = null;
    }
    cancel();
    lastRef.current = performance.now();
    changeStatus("playing");
    publish(true, lastRef.current);
    frameRef.current = requestAnimationFrame((next) => tickRef.current(next));
  }, [reduceMotion, cancel, changeStatus, publish]);

  const pause = useCallback(() => {
    if (statusRef.current !== "playing") return;
    cancel();
    changeStatus("paused");
    setSample(sampleTimeline(timelineRef.current, tRef.current));
  }, [cancel, changeStatus]);

  const stop = useCallback(() => {
    cancel();
    stepRef.current = -1;
    setStepIndex(-1);
    tRef.current = timelineRef.current.startMs;
    hourRef.current = null;
    setSample(null);
    changeStatus("idle");
    callbacks.current.onTruck(null);
    callbacks.current.onHour(null);
  }, [cancel, changeStatus]);

  const step = useCallback(
    (direction: -1 | 1) => {
      const line = timelineRef.current;
      const count = line.checkpointMs.length;
      if (count === 0) return;
      cancel();
      const next = Math.min(count - 1, Math.max(0, stepRef.current + direction));
      stepRef.current = next;
      setStepIndex(next);
      tRef.current = line.checkpointMs[next];
      publish(true, performance.now());
      if (statusRef.current !== "paused") changeStatus("paused");
    },
    [cancel, changeStatus, publish],
  );

  const setSpeed = useCallback((next: Speed) => {
    speedRef.current = next;
    setSpeedState(next);
  }, []);

  // Motion preference turned on mid-trip: stop animating, keep the truck where it is.
  useEffect(() => {
    if (reduceMotion && statusRef.current === "playing") pause();
  }, [reduceMotion, pause]);

  // Leaving the route (or the page) must leave nothing running and no truck behind.
  useEffect(() => {
    const latest = () => callbacks.current;
    return () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      if (statusRef.current !== "idle") {
        latest().onTruck(null);
        latest().onHour(null);
        latest().onPlaying(false);
      }
    };
  }, []);

  return { status, speed, setSpeed, sample, stepIndex, play, pause, stop, step };
}
