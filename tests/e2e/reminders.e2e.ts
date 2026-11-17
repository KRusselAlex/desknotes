// Reminders through the real app, on the real clock: the popover, the scheduler, the
// notifications DeskNotes sends (to the stand-in service in notifications.py), what
// their buttons do, and the reminders missed while DeskNotes was closed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, newDataDir } from "./app";
import { Notifications, type Shown } from "./notifications";
import { newNote, openTab } from "./ui";
import { waitFor, type Element } from "./webdriver";

/** WebDriver's End and Backspace keys. */
const END = "\uE010";
const BACKSPACE = "\uE003";
/** The buttons of a reminder notification (`REMINDER_ACTIONS` in src-tauri/src/reminders.rs). */
const REMINDER_BUTTONS = [
  ["snooze10", "10 min"],
  ["snooze60", "1 h"],
  ["dismiss", "Dismiss"],
  ["tomorrow", "Tomorrow"],
  ["default", ""],
];

let app: App | undefined;
let notifications: Notifications;
const systemZone = process.env.TZ;

/**
 * A fixed time zone where it is now about 10:00. DeskNotes and these tests both use it
 * (tauri-driver passes the environment on), so a reminder a minute or two away is due
 * today at any hour of the real day, and its popover starts on the right date.
 */
function morningZone(): string {
  let offset = (10 - new Date().getUTCHours() + 24) % 24;
  if (offset > 12) offset -= 24;
  // POSIX signs are inverted: Etc/GMT-3 is three hours ahead of UTC.
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

beforeEach(async () => {
  process.env.TZ = morningZone();
  notifications = await Notifications.start();
});

afterEach(async () => {
  try {
    await app?.quit();
  } finally {
    app = undefined;
    await notifications?.stop();
    if (systemZone === undefined) delete process.env.TZ;
    else process.env.TZ = systemZone;
  }
});

const pad = (n: number) => String(n).padStart(2, "0");
/** `HH:MM` of a local time, as DeskNotes shows it. */
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** `YYYY-MM-DD` of a local date, the date field's value. */
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The first whole minute at least `leadMs` from now. */
function minuteAfter(leadMs: number): Date {
  const at = new Date(Date.now() + leadMs);
  if (at.getSeconds() !== 0 || at.getMilliseconds() !== 0) at.setSeconds(60, 0);
  return at;
}

function sleepUntil(at: Date): Promise<void> {
  return new Promise((done) => setTimeout(done, Math.max(0, at.getTime() - Date.now())));
}

/** Opens the note's "More" menu and picks the item whose text starts with `item`. */
async function noteMenu(a: App, item: string): Promise<void> {
  await a.session.click(await a.session.find('button[aria-label="More"]'));
  const entry = await waitFor(`the menu item "${item}"`, () =>
    a.session.execute<Element | null>(
      "return [...document.querySelectorAll('[role^=menuitem]')].find(e => e.textContent.trim().startsWith(arguments[0])) || null",
      item,
    ),
  );
  await a.session.click(entry);
}

/**
 * Sets the note's reminder from its popover, as a person does: the time field emptied
 * with Backspace and the time typed without a colon ("0930", which it reads as 09:30),
 * then Save. (Ctrl+A does not select through WebKitWebDriver: the digits after it are
 * lost.) The date is left as it
 * starts: WebDriver cannot type into WebKitGTK's date field (it fills it part by part,
 * in the locale's order).
 */
async function setReminder(a: App, label: string, at: Date): Promise<void> {
  await a.switchToLabel(label);
  await noteMenu(a, "Set reminder");
  // The date starts as today (it is morning: see `morningZone`), the reminder's day.
  const date = await waitFor("the reminder's date field", () => a.session.find('.dn-reminder input[aria-label="Date"]'));
  expect(await a.session.execute<string>("return arguments[0].value", date)).toBe(isoDate(at));
  const time = await a.session.find('.dn-reminder input[aria-label="Time"]');
  await a.session.click(time);
  await a.session.type(time, END + BACKSPACE.repeat(8) + hhmm(at).replace(":", ""));
  const save = await a.session.execute<Element>(
    "return [...document.querySelectorAll('.dn-reminder button')].find(b => b.textContent.trim() === 'Save')",
  );
  await a.session.click(save);
  // The chip shows the time saved (today's reminders show the time alone).
  await waitFor(`the reminder chip for ${hhmm(at)}`, () =>
    a.session.execute<boolean>(
      `return !document.querySelector('.dn-reminder') &&
         [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Reminder ' + arguments[0])`,
      hhmm(at),
    ),
  );
}

/** The Reminders tab's rows: each note's title and when it is due, as shown. */
function reminderRows(a: App): Promise<{ title: string; when: string }[]> {
  return a.session.execute(
    `return [...document.querySelectorAll('.dn-rem-row')].map(r => ({
       title: r.querySelector('.dn-row-title').textContent,
       when: r.querySelector('.dn-rem-chip').textContent.trim(),
     }))`,
  );
}

/** The notification whose summary is `summary`. */
function shownFor(summary: string): Shown {
  const found = notifications.shown.filter((n) => n.summary === summary);
  expect(found, `one notification for "${summary}"`).toHaveLength(1);
  return found[0]!;
}

describe("reminders in the real app", () => {
  it("notifies with the note's title when a reminder is due, and its buttons work", async () => {
    app = await App.launch(newDataDir());
    // Three notes, enough time to set their reminders before the minute comes.
    const due = minuteAfter(35_000);
    const water = await newNote(app, ["Water the plants", "the ferns by the window"]);
    expect(await app.session.execute<number>("return new Date().getTimezoneOffset()"), "the app's time zone").toBe(
      new Date().getTimezoneOffset(),
    );
    await setReminder(app, water, due);
    const rent = await newNote(app, ["Pay the rent", "account 0042"]);
    await setReminder(app, rent, due);
    const bins = await newNote(app, ["Take out the bins", "green lid on Tuesday"]);
    await setReminder(app, bins, due);
    // The first note is hidden (its window closes), so a click on its notification has
    // something to open.
    await app.switchToLabel(water);
    await app.session.click(await app.session.find('button[aria-label="Hide note"]'));
    await waitFor("the hidden note's window to close", async () => !(await app!.noteLabels()).includes(water));
    expect(Date.now(), "the reminders were set in time (raise the lead if this fails)").toBeLessThan(due.getTime() - 3_000);
    expect(notifications.shown).toEqual([]);

    const shown = await notifications.waitForShown(3, due.getTime() - Date.now() + 15_000);
    expect(Date.now()).toBeGreaterThanOrEqual(due.getTime());
    expect(shown.map((n) => n.summary).sort()).toEqual(["Pay the rent", "Take out the bins", "Water the plants"]);
    for (const n of shown) {
      expect(n.app).toBe("DeskNotes");
      expect(n.body, "a reminder shows the title only").toBe("");
      expect(n.actions).toEqual(REMINDER_BUTTONS);
      expect(n.hints["desktop-entry"]).toBe("DeskNotes");
    }
    // The notes' other lines are never sent (CLAUDE.md, DES-36).
    expect(JSON.stringify(shown)).not.toMatch(/ferns|0042|green lid/);

    // A click on the notification opens its note.
    notifications.invoke(shownFor("Water the plants").id, "default");
    await app.switchToLabel(water);
    await waitFor("the opened note on screen", () => app!.onScreen());

    // "10 min" moves the reminder ten minutes on from now; "Dismiss" ends a one-off.
    // The app snoozes with its own clock, between these two readings.
    const before = Date.now();
    notifications.invoke(shownFor("Pay the rent").id, "snooze10");
    notifications.invoke(shownFor("Take out the bins").id, "dismiss");
    await app.manager();
    await openTab(app, "Reminders");
    const rows = await waitFor("the snoozed and dismissed reminders in the list", async () => {
      const r = await reminderRows(app!);
      return r.length === 2 && !r.some((row) => row.title === "Take out the bins") && r;
    });
    const after = Date.now();
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.when]));
    const tenMinutesOn = new Set([before, after].map((t) => hhmm(new Date(t + 10 * 60_000))));
    expect([...tenMinutesOn]).toContain(byTitle["Pay the rent"]);
    // The opened note's reminder has gone off and is overdue until it is dismissed.
    expect(byTitle["Water the plants"]).toBe(`Overdue · ${hhmm(due)}`);
  }, 120_000);

  it("sends five of the reminders missed while closed, and a summary of the rest", async () => {
    const data = newDataDir();
    app = await App.launch(data);
    // Seven reminders to set, and DeskNotes must have quit (up to 15 s) before they are due.
    const due = minuteAfter(60_000);
    const titles = ["Errand 1", "Errand 2", "Errand 3", "Errand 4", "Errand 5", "Errand 6", "Errand 7"];
    for (const title of titles) await setReminder(app, await newNote(app, [title, `private detail of ${title}`]), due);
    expect(Date.now(), "the reminders were set in time (raise the lead if this fails)").toBeLessThan(due.getTime() - 15_000);
    await app.quit();
    app = undefined;

    await sleepUntil(new Date(due.getTime() + 2_000));
    expect(notifications.shown).toEqual([]);
    app = await App.launch(data);
    const shown = await notifications.waitForShown(6, 20_000);
    // Nothing more comes.
    await new Promise((done) => setTimeout(done, 3_000));
    expect(notifications.shown).toHaveLength(6);

    const reminders = shown.filter((n) => n.summary.startsWith("Errand"));
    expect(reminders).toHaveLength(5);
    expect(new Set(reminders.map((n) => n.summary)).size).toBe(5);
    for (const n of reminders) expect(n.actions).toEqual(REMINDER_BUTTONS);
    const summary = shownFor("2 more reminders");
    expect(summary.actions).toEqual([["default", ""]]);
    for (const n of shown) expect(n.body, "a reminder shows the title only").toBe("");
    expect(JSON.stringify(shown)).not.toMatch(/private detail/);

    // DeskNotes starts with the manager hidden (its notes are open); the summary opens it.
    await app.switchToLabel("manager");
    expect(await app.onScreen()).toBe(false);
    notifications.invoke(summary.id, "default");
    await waitFor("the manager on screen", () => app!.onScreen());
    // All seven, the two summed up included, wait in the Reminders tab as overdue.
    await openTab(app, "Reminders");
    await waitFor("seven overdue reminders", async () => {
      const rows = await reminderRows(app!);
      return rows.length === 7 && rows.every((r) => r.when === `Overdue · ${hhmm(due)}`);
    });
  }, 180_000);
});
