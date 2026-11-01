/** App windows follow the system light/dark preference; notes keep their own colours. */
export function followSystemTheme(): void {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () =>
    document.documentElement.setAttribute("data-theme", dark.matches ? "dark" : "light");
  apply();
  dark.addEventListener("change", apply);
}
