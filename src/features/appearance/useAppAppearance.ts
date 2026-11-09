import { useEffect, useState } from "react";
import { commands } from "../../ipc/commands";
import { onAppAppearanceChanged } from "../../ipc/events";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance } from "../../types/note";

/** How long to wait for the listener before reading anyway: a note must not stay blank. */
export const LISTEN_WAIT_MS = 1000;

/**
 * The app-wide look of notes (Settings → Appearance): read once, then kept up to
 * date by `app-appearance-changed`. Null until the first answer, so a window can
 * wait for it instead of showing the old look. A failed read gives the defaults,
 * so a note is never kept from opening.
 */
export function useAppAppearance(): AppAppearance | null {
  const [app, setApp] = useState<AppAppearance | null>(null);

  useEffect(() => {
    let live = true;
    /** A change that arrived before the first read answered is newer: keep it. */
    let changed = false;
    let read = false;
    const readOnce = () => {
      if (!live || read) return;
      read = true;
      commands.getAppAppearance().then(
        (a) => {
          if (live && !changed) setApp(a);
        },
        () => {
          if (live && !changed) setApp({ ...APP_APPEARANCE_DEFAULTS });
        },
      );
    };
    // Listen first, and read only once listening, so a change made while the read is on
    // its way is not missed. Outside the app there may be nothing to listen to: read anyway.
    // A listener that never answers would leave the note blank: read after a while anyway.
    const unlisten = onAppAppearanceChanged((a) => {
      changed = true;
      if (live) setApp(a);
    }).catch(() => null);
    void unlisten.then(readOnce);
    const timer = setTimeout(readOnce, LISTEN_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      // Also when listening answers only after the window closed.
      void unlisten.then((f) => f?.());
    };
  }, []);

  return app;
}
