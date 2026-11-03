// Thin wrappers over Tauri window/opener APIs so components stay testable.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

export function currentWindowLabel(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    return null; // running in a plain browser (vite dev without Tauri)
  }
}

/** Run `handler` when the window manager asks to close this window. The close
 * is always prevented; the handler decides what happens. */
export function onCloseRequested(handler: () => void): Promise<() => void> {
  return getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    handler();
  });
}

export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** Close this window (the Note settings window closing itself). */
export function closeCurrentWindow(): Promise<void> {
  return getCurrentWindow().close();
}

/** The note a window was opened for: `?note=<id>` in its page URL, or null. */
export function noteIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("note");
}
