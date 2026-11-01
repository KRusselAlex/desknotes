import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { followSystemTheme } from "./app/theme";
import { currentWindowLabel } from "./ipc/window";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/note.css";
import "./styles/manager.css";
import "./styles/settings.css";

// Never let a click on a link navigate the webview itself.
document.addEventListener(
  "click",
  (e) => {
    if ((e.target as HTMLElement | null)?.closest("a[href]")) e.preventDefault();
  },
  true,
);
// No browser context menu or file drops replacing the page.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App label={currentWindowLabel()} />
  </StrictMode>,
);
