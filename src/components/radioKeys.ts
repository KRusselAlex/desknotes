import type { KeyboardEvent } from "react";

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Keyboard moves inside a radiogroup whose options are `[role="radio"]` elements:
 * arrow keys move focus to the next or previous option (wrapping), Home and End to the
 * first and last. Space or Enter then chooses, as on any button. Only the chosen option
 * should be in the Tab order (`tabIndex` 0, the others -1).
 */
export function moveAmongRadios(e: KeyboardEvent<HTMLElement>) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const at = nodes.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = nodes.length - 1;
  else if (STEPS[e.key] !== undefined) next = (at + STEPS[e.key]! + nodes.length) % nodes.length;
  else return;
  nodes[next]?.focus();
  e.preventDefault();
}

/** Index of the option that takes the Tab stop: the chosen one, or the first. */
export function tabStop(checked: readonly boolean[]): number {
  return Math.max(0, checked.indexOf(true));
}
