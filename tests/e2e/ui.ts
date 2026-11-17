// What a person does in DeskNotes' windows, as WebDriver calls: shared by the suites.
import type { App } from "./app";
import { waitFor, type Element } from "./webdriver";

/** WebDriver's Enter key. */
export const ENTER = "\uE007";

/** Titles of the rows in the manager's current list. */
export function rowTitles(a: App): Promise<string[]> {
  return a.session.execute("return [...document.querySelectorAll('[role=listitem] .dn-row-title')].map(e => e.textContent)");
}

/** Waits until the manager's list shows exactly these titles. */
export function waitForRows(a: App, titles: string[]): Promise<boolean> {
  return waitFor(`the list ${JSON.stringify(titles)}`, async () => JSON.stringify(await rowTitles(a)) === JSON.stringify(titles));
}

export async function openTab(a: App, name: string): Promise<void> {
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
export function rowButton(a: App, title: string, label: string): Promise<Element> {
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
export async function search(a: App, query: string, titles: string[]): Promise<void> {
  const box = await a.session.find('input[aria-label="Search notes"]');
  await a.session.click(box);
  await a.session.type(box, query);
  await waitForRows(a, titles);
}

/** The search box's clear button. */
export function clearSearchButton(a: App): Promise<Element> {
  return waitFor("the clear-search button", () => a.session.find('button[aria-label="Clear search"]'));
}

/** Creates a note from the manager and types `lines` into it; returns its window label. */
export async function newNote(a: App, lines: string[]): Promise<string> {
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
export function paragraphs(a: App): Promise<string[]> {
  return waitFor("the note's text", () =>
    a.session.execute<string[] | null>("const e = document.querySelector('.ProseMirror'); return e && [...e.children].map(p => p.textContent)"),
  );
}
