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

describe("images", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("addImage sends the bytes as the raw body with the note-id header", async () => {
    invoke.mockResolvedValue({ id: "a".repeat(64), width: 8, height: 6 });
    const bytes = new Uint8Array([1, 2, 3]);
    const info = await commands.addImage("n1", bytes);
    expect(invoke).toHaveBeenCalledWith("add_image", bytes, { headers: { "note-id": "n1" } });
    expect(info).toEqual({ id: "a".repeat(64), width: 8, height: 6 });
  });

  it("addImage maps a native error to a CommandError with its code", async () => {
    invoke.mockRejectedValue({ code: "image_too_large", message: "the image is too large" });
    await expect(commands.addImage("n1", new Uint8Array([1]))).rejects.toMatchObject({
      name: "CommandError",
      code: "image_too_large",
    });
  });

  it("pickImage calls pick_image with the note id; null when cancelled", async () => {
    invoke.mockResolvedValue(null);
    expect(await commands.pickImage("n1")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("pick_image", { noteId: "n1" });
  });
});
