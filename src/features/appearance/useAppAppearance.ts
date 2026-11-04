import { useEffect, useState } from "react";
import { commands } from "../../ipc/commands";
import { onAppAppearanceChanged } from "../../ipc/events";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance } from "../../types/note";

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
    // Listen first, so a change made while the read is on its way is not missed.
    const unlisten = onAppAppearanceChanged((a) => {
      changed = true;
      if (live) setApp(a);
    }).catch(() => null);
    commands.getAppAppearance().then(
      (a) => {
        if (live && !changed) setApp(a);
      },
      () => {
        if (live && !changed) setApp({ ...APP_APPEARANCE_DEFAULTS });
      },
    );
    return () => {
      live = false;
      void unlisten.then((f) => f?.());
    };
  }, []);

  return app;
}
