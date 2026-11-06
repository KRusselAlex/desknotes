import { beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "note-abc" }) }));

import {
  APP_APPEARANCE_CHANGED,
  IMAGES_DROPPED,
  REMINDERS_CHANGED,
  onAppAppearanceChanged,
  onImagesDropped,
  onRemindersChanged,
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

describe("onImagesDropped", () => {
  beforeEach(() => {
    listen.mockReset();
    listen.mockResolvedValue(() => {});
  });

  it("listens for this window only, so a drop on one note never reaches another", async () => {
    expect(IMAGES_DROPPED).toBe("images-dropped");
    const handler = vi.fn();
    await onImagesDropped(handler);
    expect(listen).toHaveBeenCalledTimes(1);
    const [name, callback, options] = listen.mock.calls[0] as [string, (e: { payload: unknown }) => void, unknown];
    expect(name).toBe("images-dropped");
    expect(options).toEqual({ target: { kind: "WebviewWindow", label: "note-abc" } });
    const payload = { noteId: "n", images: [], texts: [], problem: null, x: 1, y: 2 };
    callback({ payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });
});
