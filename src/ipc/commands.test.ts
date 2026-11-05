import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { commands } from "./commands";

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
