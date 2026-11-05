import { useLayoutEffect, useRef, useState } from "react";

/**
 * When a note's header is short on room it gives way in this order (DES-38 ruling): the date
 * disappears (CSS: it only takes spare room), then the Read-only chip drops its word and
 * keeps its icon, and only then may the reminder chip shrink. The reminder time must not be
 * cut while the word can still go, so the word's fate is measured here.
 */
export interface HeaderRoom {
  /** The header's content is wider than the header. */
  overflowing: boolean;
  /** The reminder chip's text is cut (it is the last thing allowed to shrink). */
  reminderCut: boolean;
  /** Room to spare in the header: the width of its spacer. */
  spare: number;
  /** What the word takes in the chip, gap included, as last measured while shown (0: never). */
  wordWidth: number;
}

/** Whether the Read-only word shows next, given the room measured while it `shown` or not. */
export function readOnlyWordShows(room: HeaderRoom, shown: boolean): boolean {
  if (shown) return !room.overflowing && !room.reminderCut;
  // Hidden: it comes back only when it fits whole in the spare room, and nothing is short.
  return !room.overflowing && !room.reminderCut && room.wordWidth > 0 && room.spare >= room.wordWidth;
}

/** Reads the header's room. The word's width is read only while it is shown (else `lastWord`). */
export function measureHeaderRoom(header: HTMLElement, shown: boolean, lastWord: number): HeaderRoom {
  const reminderText = header.querySelector<HTMLElement>(".dn-reminder-chip .dn-chip-text");
  const icon = header.querySelector(".dn-readonly-chip svg");
  const word = header.querySelector(".dn-readonly-chip .dn-chip-text");
  const spacer = header.querySelector(".dn-note-controls > .dn-spacer");
  return {
    overflowing: header.scrollWidth > header.clientWidth,
    reminderCut: reminderText !== null && reminderText.scrollWidth > reminderText.clientWidth,
    spare: spacer?.getBoundingClientRect().width ?? 0,
    // From the icon's right edge to the word's: the word and the gap before it.
    wordWidth:
      shown && icon && word ? word.getBoundingClientRect().right - icon.getBoundingClientRect().right : lastWord,
  };
}

/**
 * Whether the Read-only chip shows its word in `header`. Measured before paint whenever
 * `contentKey` (what the header holds) changes and whenever the header is resized.
 */
export function useReadOnlyWord(header: HTMLElement | null, active: boolean, contentKey: string): boolean {
  const [shown, setShown] = useState(true);
  const wordWidth = useRef(0);

  useLayoutEffect(() => {
    if (!header || !active) return;
    const measure = () => {
      const room = measureHeaderRoom(header, shown, wordWidth.current);
      wordWidth.current = room.wordWidth;
      const next = readOnlyWordShows(room, shown);
      if (next !== shown) setShown(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(header);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [header, active, contentKey, shown]);

  return shown;
}
