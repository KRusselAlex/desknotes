// Notes through the real app: the manager, note windows, SQLite and restarts.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { App, databasePath, newDataDir, x11Windows } from "./app";
import { newNote, openTab, paragraphs, rowButton, rowTitles, search, clearSearchButton, waitForRows } from "./ui";
import { waitFor } from "./webdriver";

let app: App | undefined;

afterEach(async () => {
  await app?.quit();
  app = undefined;
});

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
    expect(await app.onScreen()).toBe(false);
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
