// Notes through the real app: the manager, note windows, SQLite and restarts.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { App, databasePath, newDataDir, x11Windows } from "./app";
import { waitFor, type Element } from "./webdriver";

/** WebDriver's Enter key. */
const ENTER = "\uE007";

let app: App | undefined;

afterEach(async () => {
  await app?.quit();
  app = undefined;
});

/** Titles of the rows in the manager's current list. */
function rowTitles(a: App): Promise<string[]> {
  return a.session.execute("return [...document.querySelectorAll('[role=listitem] .dn-row-title')].map(e => e.textContent)");
}

/** Waits until the manager's list shows exactly these titles. */
function waitForRows(a: App, titles: string[]): Promise<boolean> {
  return waitFor(`the list ${JSON.stringify(titles)}`, async () => JSON.stringify(await rowTitles(a)) === JSON.stringify(titles));
}

async function openTab(a: App, name: string): Promise<void> {
  const tab = await waitFor(`the ${name} tab`, () =>
    a.session.execute<Element | null>(
      "return [...document.querySelectorAll('[role=tab]')].find(t => t.textContent.startsWith(arguments[0])) || null",
      name,
    ),
  );
  await a.session.click(tab);
  await waitFor(`the ${name} tab to open`, () =>
    a.session.execute<boolean>("return document.querySelector('[role=tab][aria-selected=true]').textContent.startsWith(arguments[0])", name),
  );
}

/** A button inside the manager row whose title is `title`, once hovering has shown it. */
function rowButton(a: App, title: string, label: string): Promise<Element> {
  return waitFor(`"${label}" on the row "${title}"`, async () => {
    const row = await a.session.execute<Element | null>(
      "return [...document.querySelectorAll('[role=listitem]')].find(r => r.querySelector('.dn-row-title')?.textContent === arguments[0]) || null",
      title,
    );
    if (!row) return undefined;
    await a.session.hover(row);
    return a.session.execute<Element | null>(
      `const b = [...arguments[0].querySelectorAll('button')]
         .find(b => b.getAttribute('aria-label') === arguments[1] || b.textContent.trim() === arguments[1]);
       return b && getComputedStyle(b).visibility === 'visible' ? b : null;`,
      row,
      label,
    );
  });
}

/** Searches the manager (the search reads the database) and waits for these titles. */
async function search(a: App, query: string, titles: string[]): Promise<void> {
  const box = await a.session.find('input[aria-label="Search notes"]');
  await a.session.click(box);
  await a.session.type(box, query);
  await waitForRows(a, titles);
}

/** The search box's clear button. */
function clearSearchButton(a: App): Promise<Element> {
  return waitFor("the clear-search button", () => a.session.find('button[aria-label="Clear search"]'));
}

/** Creates a note from the manager and types `lines` into it; returns its window label. */
async function newNote(a: App, lines: string[]): Promise<string> {
  await a.manager();
  const before = await a.noteLabels();
  await a.session.click(await a.session.find('button[aria-label="New note"]'));
  const label = await waitFor("a new note window", async () => (await a.noteLabels()).find((l) => !before.includes(l)));
  await a.switchToLabel(label);
  const editor = await waitFor("the note's editor", () => a.session.find(".ProseMirror"));
  await a.session.click(editor);
  await a.session.type(editor, lines.join(ENTER));
  return label;
}

/** The note's paragraphs, as text. */
function paragraphs(a: App): Promise<string[]> {
  return waitFor("the note's text", () =>
    a.session.execute<string[] | null>("const e = document.querySelector('.ProseMirror'); return e && [...e.children].map(p => p.textContent)"),
  );
}

describe("notes in the real app", () => {
  it("first start opens the welcome note and lists it in the manager", async () => {
    const data = newDataDir();
    app = await App.launch(data);
    expect(existsSync(databasePath(data)), "the database is in this test's data folder").toBe(true);
    const notes = await waitFor("the welcome note window", async () => {
      const labels = await app!.noteLabels();
      return labels.length > 0 && labels;
    });
    expect(notes).toHaveLength(1);
    await app.switchToLabel(notes[0]!);
    expect((await paragraphs(app))[0]).toMatch(/^Welcome/);

    await app.manager();
    await waitFor("one active note", async () => {
      const titles = await rowTitles(app!);
      return titles.length === 1 && /^Welcome/.test(titles[0]!);
    });
  });

  it("saves a new note's text and brings its window back after a restart", async () => {
    const data = newDataDir();
    app = await App.launch(data);
    const label = await newNote(app, ["Shopping list", "milk and bread"]);

    // The last words typed are in the database once the search finds them.
    await app.manager();
    await search(app, "bread", ["Shopping list"]);
    // Window titles are shown to others: none carries the note's text (design D7).
    expect(x11Windows().filter((w) => /Shopping|milk|bread/.test(w.name))).toEqual([]);

    await app.quit();
    app = await App.launch(data);
    expect(await waitFor("the note window to reopen", async () => (await app!.noteLabels()).includes(label))).toBe(true);
    // With notes to show, DeskNotes starts with the manager hidden.
    await app.switchToLabel("manager");
    expect(await app.managerOnScreen()).toBe(false);
    await app.openManagerFromMenu();

    await app.switchToLabel(label);
    expect(await paragraphs(app)).toEqual(["Shopping list", "milk and bread"]);
  });

  it("closes a trashed note's window and lists it again once restored", async () => {
    app = await App.launch(newDataDir());
    const label = await newNote(app, ["Call the plumber"]);
    await app.manager();
    await search(app, "plumber", ["Call the plumber"]);
    await app.session.click(await clearSearchButton(app));
    const welcome = await waitFor("the full list again", async () => {
      const titles = await rowTitles(app!);
      return titles.length === 2 && titles.find((t) => t.startsWith("Welcome"));
    });

    await app.session.click(await rowButton(app, "Call the plumber", "Move to trash"));
    await waitFor("the note window to close", async () => !(await app!.noteLabels()).includes(label));
    await app.manager();
    await waitForRows(app, [welcome]);

    await openTab(app, "Trash");
    await app.session.click(await rowButton(app, "Call the plumber", "Restore"));
    await waitForRows(app, []);
    await openTab(app, "Active");
    await waitFor("the restored note in Active", async () => (await rowTitles(app!)).includes("Call the plumber"));
  });
});
