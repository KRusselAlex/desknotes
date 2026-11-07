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

  it("enablePurgeTrash calls enable_purge_trash with the days only", async () => {
    const saved: Automations = {
      autoCompleteChecklists: false,
      resetChecklistsOnRepeat: false,
      archiveDoneEnabled: false,
      archiveDoneDays: 7,
      purgeTrashEnabled: true,
      purgeTrashDays: 30,
      purgeOffByRestore: false,
    };
    invoke.mockResolvedValue(saved);
    expect(await commands.enablePurgeTrash(30)).toEqual(saved);
    expect(invoke).toHaveBeenCalledWith("enable_purge_trash", { days: 30 });
  });

  it("countPurgeable calls count_purgeable with the days only", async () => {
    invoke.mockResolvedValue(4);
    expect(await commands.countPurgeable(30)).toBe(4);
    expect(invoke).toHaveBeenCalledWith("count_purgeable", { days: 30 });
  });
});

describe("claimChecklistReset", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("calls claim_checklist_reset with the note id and returns whether a reset was waiting", async () => {
    invoke.mockResolvedValue(true);
    expect(await commands.claimChecklistReset("n1")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("claim_checklist_reset", { noteId: "n1" });
  });
});
