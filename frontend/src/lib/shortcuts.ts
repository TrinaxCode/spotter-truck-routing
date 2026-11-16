/** Keyboard shortcuts for power users (dispatchers live in this screen). Single keys, no modifiers. */
export const SHORTCUTS = [
  { keys: ["1", "2", "3"], label: "Select the route ranked 1, 2 or 3" },
  { keys: ["D"], label: "Drive the selected route (start or pause)" },
  { keys: ["E"], label: "Edit the trip" },
  { keys: ["S"], label: "Copy a link to this trip" },
  { keys: ["P"], label: "Print the driver briefing" },
  { keys: ["T"], label: "Switch light / dark theme" },
  { keys: ["?"], label: "Show these shortcuts" },
] as const;

/** Window event the trip playback listens to, so the shortcut needs no handle on its state. */
export const DRIVE_TOGGLE_EVENT = "trip:drive-toggle";

/** True when a key press belongs to a control (typing, a slider, an open listbox), not to the app. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("input, textarea, select, [role='combobox'], [role='slider'], [role='listbox']")) return true;
  return false;
}

/** Maps a keydown to an app action, or null when the app should not react. */
export function shortcutFor(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "target" | "repeat">,
): "route-1" | "route-2" | "route-3" | "drive" | "edit" | "share" | "print" | "theme" | "help" | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTypingTarget(event.target)) return null;
  switch (event.key) {
    case "1":
    case "2":
    case "3":
      return `route-${event.key}` as "route-1" | "route-2" | "route-3";
    case "d":
    case "D":
      return "drive";
    case "e":
    case "E":
      return "edit";
    case "s":
    case "S":
      return "share";
    case "p":
    case "P":
      return "print";
    case "t":
    case "T":
      return "theme";
    case "?":
      return "help";
    default:
      return null;
  }
}
