import type { KeyboardEvent } from "react";

const STEPS: Record<string, number | undefined> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * WAI-ARIA radio group keys: arrows wrap, select the neighbour and move focus to it.
 * Pair with roving tabindex (`tabIndex={checked ? 0 : -1}`) so Tab leaves the group.
 */
export function onRadioKeyDown(
  event: KeyboardEvent<HTMLElement>,
  current: number,
  count: number,
  select: (index: number) => void,
): void {
  const step = STEPS[event.key];
  if (!step) return;
  event.preventDefault();
  const next = (current + step + count) % count;
  select(next);
  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}
