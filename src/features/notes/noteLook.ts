import { useEffect } from "react";
import type { AppAppearance, Appearance } from "../../types/note";
import { appClasses, appearanceStyle, effectiveAppearance, isSeeThrough } from "../appearance/appearance";

/** The native window is transparent only below 100 % opacity; then the page must be too. */
export function useSeeThrough(appearance: Appearance) {
  const see = isSeeThrough(appearance);
  useEffect(() => {
    document.documentElement.classList.toggle("dn-see-through", see);
    return () => document.documentElement.classList.remove("dn-see-through");
  }, [see]);
}

/** Root class and CSS variables of a note: its own values over the app defaults,
 * and the app's high contrast and layout as classes (CSS only, nothing stored). */
export function noteLook(color: string, appearance: Appearance, app: AppAppearance) {
  const shown = effectiveAppearance(appearance, app);
  return { classes: appClasses(app), style: appearanceStyle(color, shown), shown };
}
