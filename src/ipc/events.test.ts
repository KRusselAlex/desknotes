import { beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));
const currentWebviewWindow = vi.fn(() => ({ label: "note-abc" }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => currentWebviewWindow() }));

import {
  APP_APPEARANCE_CHANGED,
  NOTE_ACTION,
  NOTE_RESIZED,
  NOTE_SETTINGS_NOTE,
  PRIVACY_CHANGED,
  REMINDERS_CHANGED,
  SETTINGS_SECTION,
  onAppAppearanceChanged,
  onNoteAction,
  onNoteResized,
  onNoteSettingsNote,
  onPrivacyChanged,
  onRemindersChanged,
  onSettingsSection,
} from "./events";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance } from "../types/note";

describe("onAppAppearanceChanged", () => {
  beforeEach(() => {
    listen.mockReset();
    listen.mockResolvedValue(() => {});
  });

  it("listens on app-appearance-changed and passes the payload on", async () => {
    expect(APP_APPEARANCE_CHANGED).toBe("app-appearance-changed");
    const handler = vi.fn();
    await onAppAppearanceChanged(handler);
    expect(listen).toHaveBeenCalledTimes(1);
    const [name, callback] = listen.mock.calls[0] as [string, (e: { payload: AppAppearance }) => void];
    expect(name).toBe("app-appearance-changed");
    const next: AppAppearance = { highContrast: true, layout: "compact", defaultFont: "Ubuntu", defaultSize: 18 };
    callback({ payload: next });
    expect(handler).toHaveBeenCalledWith(next);
  });

  it("returns the unlisten function", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    expect(await onAppAppearanceChanged(() => {})).toBe(unlisten);
  });
});

describe("APP_APPEARANCE_DEFAULTS", () => {
  it("matches the native defaults", () => {
    expect(APP_APPEARANCE_DEFAULTS).toEqual({
      highContrast: false,
      layout: "comfortable",
      defaultFont: null,
      defaultSize: 15,
    });
  });
});

describe("onRemindersChanged", () => {
  beforeEach(() => {
    listen.mockReset();
    listen.mockResolvedValue(() => {});
  });

  it("listens on reminders-changed and passes the note id on", async () => {
    expect(REMINDERS_CHANGED).toBe("reminders-changed");
    const handler = vi.fn();
    await onRemindersChanged(handler);
    const [name, callback] = listen.mock.calls[0] as [string, (e: { payload: { noteId: string | null } }) => void];
    expect(name).toBe("reminders-changed");
    callback({ payload: { noteId: "a2" } });
    callback({ payload: { noteId: null } });
    expect(handler.mock.calls).toEqual([[{ noteId: "a2" }], [{ noteId: null }]]);
  });
});

// Rust sends these to one window with `emit_to`. Tauri 2 also delivers such an event to every
// listener registered without a target, so each must listen for its own window only.
describe("events sent to one window", () => {
  beforeEach(() => {
    listen.mockReset();
    listen.mockResolvedValue(() => {});
  });

  it.each([
    [NOTE_ACTION, "note-action", onNoteAction, "trash"],
    [PRIVACY_CHANGED, "privacy-changed", onPrivacyChanged, { locked: true }],
    [SETTINGS_SECTION, "settings-section", onSettingsSection, "privacy"],
    [NOTE_RESIZED, "note-resized", onNoteResized, { id: "n", width: 300, height: 200 }],
    [NOTE_SETTINGS_NOTE, "note-settings-note", onNoteSettingsNote, "n"],
  ] as [string, string, (h: (p: unknown) => void) => Promise<unknown>, unknown][])(
    "%s listens for this window only and passes the payload on",
    async (constant, name, subscribe, payload) => {
      expect(constant).toBe(name);
      const handler = vi.fn();
      await subscribe(handler);
      expect(listen).toHaveBeenCalledTimes(1);
      const [event, callback, options] = listen.mock.calls[0] as [string, (e: { payload: unknown }) => void, unknown];
      expect(event).toBe(name);
      expect(options).toEqual({ target: { kind: "WebviewWindow", label: "note-abc" } });
      callback({ payload });
      expect(handler).toHaveBeenCalledWith(payload);
    },
  );

  it("rejects instead of throwing when there is no Tauri window (tests, preview)", async () => {
    currentWebviewWindow.mockImplementationOnce(() => {
      throw new Error("no window");
    });
    const subscribed = onSettingsSection(() => {});
    await expect(subscribed).rejects.toThrow("no window");
    expect(listen).not.toHaveBeenCalled();
  });
});
