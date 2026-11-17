import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  dayAccessibleName,
  dayStrip,
  explainDisabledHours,
  hourSlots,
  minuteSlots,
  nextEnabledIndex,
  quickPicks,
  resolveSelection,
  selectionParts,
  summaryLine,
  triggerLabel,
} from "../lib/departurePicker";
import "../styles/departure-picker.css";

interface DeparturePickerProps {
  id: string;
  /** datetime-local value, `YYYY-MM-DDTHH:mm`. */
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  /** Frozen clock for tests. Defaults to the current time. */
  now?: Date;
}

interface Choice {
  id: string;
  name: string;
  checked: boolean;
  disabled: boolean;
  reason?: string;
  className: string;
  relation?: string;
  content: ReactNode;
}

export function DeparturePicker({ id, value, onChange, onBlur, error, now: nowProp }: DeparturePickerProps) {
  const now = nowProp ?? new Date();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const summaryId = `${id}-summary`;
  const errorId = `${id}-error`;
  const panelId = `${id}-panel`;
  const windowId = `${id}-window`;
  const parts = selectionParts(value, now);
  const summary = summaryLine(value, now);
  const showSummary = !error || open;
  const describedBy = [showSummary ? summaryId : null, error ? errorId : null].filter(Boolean).join(" ");

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: Event) {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      // Cancel the pointer so the outside control does not take focus, then
      // hand it back to the trigger. A cancelled pointerdown also suppresses
      // the compatibility click, which is the dismiss-without-activating behaviour.
      event.preventDefault();
      triggerRef.current?.focus();
      setOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      triggerRef.current?.focus();
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;

    const place = () => {
      const phone = window.matchMedia("(max-width: 767px)").matches;
      if (phone) {
        panel.style.removeProperty("--departure-top");
        panel.style.removeProperty("--departure-left");
        panel.style.removeProperty("--departure-width");
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(rect.width, window.innerWidth - margin * 2);
      if (width < 1) return;
      panel.style.setProperty("--departure-width", `${width}px`);
      const height = Math.min(panel.offsetHeight, window.innerHeight - margin * 2);
      const clampTop = (value: number) => Math.max(margin, Math.min(value, window.innerHeight - height - margin));
      // Beside the trip panel when the map has room: the picker then covers no form field.
      const side = trigger.closest(".panel")?.getBoundingClientRect();
      if (side && side.right + 12 + width <= window.innerWidth - margin) {
        panel.style.setProperty("--departure-top", `${clampTop(rect.top - 64)}px`);
        panel.style.setProperty("--departure-left", `${side.right + 12}px`);
        return;
      }
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - margin) {
        const above = rect.top - 6 - height;
        top = above >= margin ? above : clampTop(top);
      }
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      panel.style.setProperty("--departure-top", `${top}px`);
      panel.style.setProperty("--departure-left", `${left}px`);
    };

    place();
    const scroller = trigger.closest(".panel-scroll");
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => place());
      observer.observe(panel);
    }
    return () => {
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const dayStripEl = panel.querySelector<HTMLElement>(".departure-days");
    const day = panel.querySelector<HTMLElement>(".departure-day[aria-checked='true']");
    if (dayStripEl && day) scrollChildIntoView(dayStripEl, day, "x");
    const hourStrip = panel.querySelector<HTMLElement>(".departure-hours");
    const hour = panel.querySelector<HTMLElement>(".departure-hour[aria-checked='true']");
    if (hourStrip && hour) scrollChildIntoView(hourStrip, hour, "y");
    const minute = panel.querySelector<HTMLElement>(".departure-minute[aria-checked='true']");
    if (window.matchMedia("(max-width: 767px)").matches) revealInSheet(day ?? panel, minute ?? hour ?? panel);
  }, [open, value]);

  function commit(next: string | null) {
    if (next && next !== value) onChange(next);
  }

  function onFieldBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    onBlur?.();
  }

  const picks = quickPicks(now);
  const days = open ? dayStrip(now) : [];
  const hours = open ? hourSlots(parts.dayKey, parts.minute, now) : [];
  const minutes = open ? minuteSlots(parts.dayKey, parts.hour, parts.minute, now) : [];
  const windowNote = explainDisabledHours(hours);
  const summaryNode = (
    <p id={summaryId} className="departure-summary" data-testid="departure-summary" aria-live="polite">
      {summary}
    </p>
  );

  return (
    <div className="field departure-field" ref={rootRef} onBlur={onFieldBlur}>
      <label id={`${id}-label`} htmlFor={id}>
        Departure
      </label>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="departure-trigger"
        data-testid="departure-trigger"
        data-departure={value}
        aria-labelledby={`${id}-label ${id}-current`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-invalid={error ? "true" : undefined}
        aria-describedby={describedBy || undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span id={`${id}-current`} className="departure-trigger-value">
          {triggerLabel(value)}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="departure-panel"
          data-testid="departure-panel"
          role="group"
          aria-label="Choose a departure"
        >
          {summaryNode}
          <ChoiceGroup
            label="Quick departures"
            className="departure-chips"
            columns={1}
            choices={picks.map((pick) => ({
              id: pick.id,
              name: pick.label,
              checked: !pick.disabled && pick.value === value,
              disabled: pick.disabled,
              reason: pick.reason,
              className: "departure-choice departure-chip",
              content: pick.label,
            }))}
            onSelect={(pickId) => {
              const pick = picks.find((item) => item.id === pickId);
              if (pick && !pick.disabled) commit(pick.value);
            }}
          />
          <ChoiceGroup
            label="Departure day"
            caption="Day"
            className="departure-days"
            columns={1}
            orientation="horizontal"
            choices={days.map((day) => ({
              id: day.key,
              name: dayAccessibleName(day),
              checked: day.key === parts.dayKey,
              disabled: day.disabled,
              reason: day.reason,
              className: "departure-choice departure-day",
              relation: day.relation ? day.relation.toLowerCase() : "later",
              content: (
                <>
                  <span className="departure-day-name">{day.weekday}</span>
                  <span className="departure-day-num">{day.day}</span>
                  <span className="departure-day-rel">{day.relation ?? "\u00a0"}</span>
                </>
              ),
            }))}
            onSelect={(dayKey) => commit(resolveSelection(dayKey, parts.hour, parts.minute, now))}
          />
          <ChoiceGroup
            label="Hour"
            caption="Hour"
            className="departure-hours"
            columns={4}
            describedBy={windowNote ? windowId : undefined}
            choices={hours.map((hour) => ({
              id: String(hour.hour),
              name: hour.label,
              checked: hour.hour === parts.hour,
              disabled: hour.disabled,
              reason: hour.reason,
              className: "departure-choice departure-hour",
              content: hour.label,
            }))}
            onSelect={(hourId) => commit(resolveSelection(parts.dayKey, Number(hourId), parts.minute, now))}
          />
          <ChoiceGroup
            label="Minute"
            caption="Minute"
            className="departure-minutes"
            columns={4}
            choices={minutes.map((minute) => ({
              id: String(minute.minute),
              name: minute.label,
              checked: minute.minute === parts.minute,
              disabled: minute.disabled,
              reason: minute.reason,
              className: "departure-choice departure-minute",
              content: minute.label,
            }))}
            onSelect={(minuteId) => commit(resolveSelection(parts.dayKey, parts.hour, Number(minuteId), now))}
          />
          {windowNote ? (
            <p id={windowId} className="departure-note" data-testid="departure-window">
              {windowNote}
            </p>
          ) : null}
        </div>
      ) : null}
      {!open && !error ? summaryNode : null}
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChoiceGroup({
  label,
  caption,
  className,
  columns,
  choices,
  describedBy,
  orientation,
  onSelect,
}: {
  label: string;
  caption?: string;
  className: string;
  columns: number;
  choices: Choice[];
  describedBy?: string;
  orientation?: "horizontal" | "vertical";
  onSelect: (id: string) => void;
}) {
  const enabled = choices.map((choice) => !choice.disabled);
  const checkedIndex = choices.findIndex((choice) => choice.checked);
  const enabledIndex = enabled.findIndex(Boolean);
  const tabOwner = checkedIndex >= 0 ? checkedIndex : Math.max(enabledIndex, 0);

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number, next: number) {
    const choice = choices[next];
    if (next === index || !choice || choice.disabled) return;
    event.preventDefault();
    onSelect(choice.id);
    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? enabled.findIndex(Boolean) : lastEnabled(enabled);
      if (next >= 0) move(event, index, next);
      return;
    }
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? columns
      : event.key === "ArrowUp" ? -columns
      : 0;
    if (!step) return;
    event.preventDefault();
    move(event, index, nextEnabledIndex(index, step, enabled));
  }

  return (
    <div className="departure-block">
      {caption ? (
        <span className="departure-caption" aria-hidden="true">
          {caption}
        </span>
      ) : null}
      <div
        role="radiogroup"
        aria-label={label}
        aria-orientation={orientation}
        aria-describedby={describedBy}
        className={className}
      >
      {choices.map((choice, index) => (
        <button
          key={choice.id}
          type="button"
          role="radio"
          className={choice.className}
          aria-checked={choice.checked}
          aria-disabled={choice.disabled || undefined}
          aria-label={choice.disabled && choice.reason ? `${choice.name}. ${choice.reason}` : choice.name}
          tabIndex={index === tabOwner ? 0 : -1}
          title={choice.disabled ? choice.reason : undefined}
          data-relation={choice.relation}
          onClick={() => {
            if (!choice.disabled) onSelect(choice.id);
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {choice.content}
        </button>
      ))}
      </div>
    </div>
  );
}

function lastEnabled(enabled: boolean[]): number {
  for (let index = enabled.length - 1; index >= 0; index -= 1) {
    if (enabled[index]) return index;
  }
  return -1;
}

function scrollByAxis(container: HTMLElement, axis: "x" | "y", delta: number) {
  if (delta === 0) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    container.scrollBy({ [axis === "x" ? "left" : "top"]: delta, behavior: reduce ? "auto" : "smooth" });
  } catch {
    if (axis === "x") container.scrollLeft += delta;
    else container.scrollTop += delta;
  }
}

function scrollChildIntoView(container: HTMLElement, child: HTMLElement, axis: "x" | "y") {
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  const fullyVisible =
    axis === "x"
      ? childRect.left >= containerRect.left - 1 && childRect.right <= containerRect.right + 1
      : childRect.top >= containerRect.top - 1 && childRect.bottom <= containerRect.bottom + 1;
  if (fullyVisible) return;
  if (axis === "x") {
    const delta =
      childRect.left < containerRect.left ? childRect.left - containerRect.left : childRect.right - containerRect.right;
    scrollByAxis(container, "x", delta);
    return;
  }
  const childMid = childRect.top + childRect.height / 2;
  const viewMid = containerRect.top + containerRect.height / 2;
  scrollByAxis(container, "y", childMid - viewMid);
}

/** On a phone the forecast dock sits against the sheet. Keep the day and the minute inside it. */
function revealInSheet(top: HTMLElement, bottom: HTMLElement) {
  const scroller = bottom.closest(".panel-scroll");
  if (!(scroller instanceof HTMLElement)) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const topRect = top.getBoundingClientRect();
  const bottomRect = bottom.getBoundingClientRect();
  const pad = 8;
  const fits = bottomRect.bottom - topRect.top <= scrollerRect.height - pad * 2;
  const delta = fits
    ? bottomRect.bottom > scrollerRect.bottom - pad
      ? bottomRect.bottom - (scrollerRect.bottom - pad)
      : topRect.top < scrollerRect.top + pad
        ? topRect.top - (scrollerRect.top + pad)
        : 0
    : topRect.top - (scrollerRect.top + pad);
  scrollByAxis(scroller, "y", delta);
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="departure-chevron"
      data-open={open ? "true" : "false"}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M4 6.5 8 10.5 12 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
