import { measureHeaderRoom, readOnlyWordShows, type HeaderRoom } from "./readOnlyWord";

const room = (over: Partial<HeaderRoom> = {}): HeaderRoom => ({
  overflowing: false,
  reminderCut: false,
  spare: 0,
  wordWidth: 61,
  ...over,
});

describe("readOnlyWordShows (the header gives way: date, then the Read-only word, then the rest)", () => {
  it("keeps the word while everything fits", () => {
    expect(readOnlyWordShows(room(), true)).toBe(true);
  });

  it("drops the word as soon as the header is short, before the reminder time is cut", () => {
    expect(readOnlyWordShows(room({ overflowing: true }), true)).toBe(false);
    expect(readOnlyWordShows(room({ reminderCut: true }), true)).toBe(false);
  });

  it("brings it back only when the spare room holds it whole", () => {
    expect(readOnlyWordShows(room({ spare: 60 }), false)).toBe(false);
    expect(readOnlyWordShows(room({ spare: 61 }), false)).toBe(true);
    // Still short even without the word (the reminder is then the last resort): stays off.
    expect(readOnlyWordShows(room({ spare: 200, reminderCut: true }), false)).toBe(false);
  });

  it("never brings back a word it has not measured", () => {
    expect(readOnlyWordShows(room({ spare: 500, wordWidth: 0 }), false)).toBe(false);
  });
});

describe("measureHeaderRoom", () => {
  function header() {
    const el = document.createElement("header");
    el.innerHTML = `
      <button class="dn-readonly-chip"><svg></svg><span class="dn-chip-text">Read-only</span></button>
      <button class="dn-reminder-chip"><svg></svg><span class="dn-chip-text">14:41</span></button>
      <div class="dn-note-controls"><button></button><span class="dn-spacer"></span><button></button></div>`;
    const set = (target: Element, prop: string, value: number) => Object.defineProperty(target, prop, { configurable: true, value });
    const rect = (target: Element, left: number, right: number) =>
      (target.getBoundingClientRect = () => ({ left, right, width: right - left }) as DOMRect);
    return { el, set, rect, q: (s: string) => el.querySelector(s)! };
  }

  it("reads overflow, a cut reminder, the spare room and, while shown, the word's width with the gap", () => {
    const { el, set, rect, q } = header();
    set(el, "scrollWidth", 312);
    set(el, "clientWidth", 300);
    set(q(".dn-reminder-chip .dn-chip-text"), "scrollWidth", 36);
    set(q(".dn-reminder-chip .dn-chip-text"), "clientWidth", 30);
    rect(q(".dn-readonly-chip svg"), 26, 39);
    rect(q(".dn-readonly-chip .dn-chip-text"), 44, 100); // 56 wide, after a 5 px gap
    rect(q(".dn-spacer"), 200, 204);
    expect(measureHeaderRoom(el, true, 0)).toEqual({ overflowing: true, reminderCut: true, spare: 4, wordWidth: 61 });
  });

  it("keeps the last measured word width while the word is hidden", () => {
    const { el, set, rect, q } = header();
    set(el, "scrollWidth", 300);
    set(el, "clientWidth", 300);
    rect(q(".dn-readonly-chip svg"), 26, 39);
    rect(q(".dn-readonly-chip .dn-chip-text"), 0, 1); // visually hidden
    rect(q(".dn-spacer"), 150, 199);
    expect(measureHeaderRoom(el, false, 61)).toEqual({ overflowing: false, reminderCut: false, spare: 49, wordWidth: 61 });
  });
});
