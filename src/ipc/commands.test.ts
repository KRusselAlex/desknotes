import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { commands } from "./commands";
import type { Automations } from "../types/note";

describe("setNoteCompleted", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
  });

  it("calls set_note_completed with the note id and the done flag", async () => {
    await commands.setNoteCompleted("n1", true);
    expect(invoke).toHaveBeenCalledWith("set_note_completed", { id: "n1", done: true });
    await commands.setNoteCompleted("n1", false);
    expect(invoke).toHaveBeenLastCalledWith("set_note_completed", { id: "n1", done: false });
  });
});

describe("openExternalLink", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
  });

  it("calls open_external_link with the link id only, never a URL", async () => {
    await commands.openExternalLink("notices");
    expect(invoke).toHaveBeenCalledWith("open_external_link", { id: "notices" });
  });
});

describe("automations", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
  });

  it("setAutomations calls set_automations with the whole settings object", async () => {
    const automations: Automations = {
      autoCompleteChecklists: true,
      resetChecklistsOnRepeat: false,
      archiveDoneEnabled: true,
      archiveDoneDays: 7,
      purgeTrashEnabled: false,
      purgeTrashDays: 30,
      purgeOffByRestore: false,
    };
    invoke.mockResolvedValue(automations);
    expect(await commands.setAutomations(automations)).toEqual(automations);
    expect(invoke).toHaveBeenCalledWith("set_automations", { automations });
  });

  it("countPurgeable calls count_purgeable with the days only", async () => {
    invoke.mockResolvedValue(4);
    expect(await commands.countPurgeable(30)).toBe(4);
    expect(invoke).toHaveBeenCalledWith("count_purgeable", { days: 30 });
  });
});
