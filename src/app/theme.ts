/**
 * App windows follow the system light/dark preference. A note window is always light: notes
 * keep their own colours (R14), and so does everything drawn on them (popovers, the PIN pad,
 * dialogs), so no dark token (focus, accent, danger, app colours) can reach a note.
 */
export function followSystemTheme(alwaysLight = false): void {
  if (alwaysLight) {
    document.documentElement.setAttribute("data-theme", "light");
    return;
  }
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () =>
    document.documentElement.setAttribute("data-theme", dark.matches ? "dark" : "light");
  apply();
  dark.addEventListener("change", apply);
}
