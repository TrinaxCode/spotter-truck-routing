import { useEffect, useId, useRef, useState } from "react";
import { describeApiError } from "../api/errors";
import type { GeoPoint } from "../api/types";

interface PlaceComboboxProps {
  id: string;
  label: string;
  value: GeoPoint | null;
  onChange: (place: GeoPoint | null) => void;
  search: (query: string, signal: AbortSignal) => Promise<GeoPoint[]>;
  error?: string;
  onBlur?: () => void;
}

export function PlaceCombobox({ id, label, value, onChange, search, error, onBlur }: PlaceComboboxProps) {
  const listId = useId();
  const [text, setText] = useState(value?.label ?? "");
  const [seenLabel, setSeenLabel] = useState(value?.label ?? null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<GeoPoint[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [remoteHint, setRemoteHint] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const searchRef = useRef(search);
  const selectedLabel = value?.label ?? null;
  if (selectedLabel !== seenLabel) {
    setSeenLabel(selectedLabel);
    if (selectedLabel) setText(selectedLabel);
  }

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const query = text.trim();
    if (value && query === value.label) return;
    if (query.length < 3) return;
    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      searchRef
        .current(query, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return;
          setOptions(results);
          setActive(0);
          setOpen(true);
          setRemoteHint(results.length === 0 ? "No matches." : "");
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setOptions([]);
          setOpen(true);
          setRemoteHint(describeApiError(caught, "Search failed. Try again."));
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text, value]);

  const shortHint =
    text.trim().length > 0 && text.trim().length < 3 && text !== value?.label ? "Type at least 3 letters." : "";
  const hint = shortHint || remoteHint;
  const activeId = options.length > 0 ? `${listId}-${active}` : undefined;

  function choose(place: GeoPoint) {
    // A slower request for an older query must not reopen the list over this choice.
    abortRef.current?.abort();
    setBusy(false);
    onChange(place);
    setText(place.label);
    setOpen(false);
    setRemoteHint("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(options.length > 0);
        setActive(0);
        return;
      }
      setActive((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, options.length - 1));
    } else if (event.key === "Enter" && open && options[active]) {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? activeId : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-hint` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (!value || next !== value.label) onChange(null);
          if (next.trim().length < 3) {
            abortRef.current?.abort();
            setBusy(false);
            setOptions([]);
            setRemoteHint("");
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
          onBlur?.();
        }}
        onFocus={() => {
          if (options.length > 0 && text !== value?.label) setOpen(true);
        }}
      />
      <ul id={listId} role="listbox" hidden={!open}>
        {options.map((place, index) => (
          <li key={`${place.label}-${place.lat}`} role="presentation">
            <button
              type="button"
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(place)}
            >
              {place.label}
            </button>
          </li>
        ))}
      </ul>
      <p id={`${id}-hint`} className={error ? "field-error" : "field-hint"}>
        {error || hint || (busy ? "Searching…" : "")}
      </p>
      <span className="sr-only" role="status">
        {busy ? "Searching" : open && options.length > 0 ? `${options.length} suggestions available.` : ""}
      </span>
    </div>
  );
}
