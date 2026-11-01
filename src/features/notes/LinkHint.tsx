import { useEffect, useState } from "react";

interface Hint {
  host: string;
  left: number;
  top: number;
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** "Ctrl+click to open" tooltip after hovering a link for 500 ms (design N11). */
export function LinkHint({ container }: { container: HTMLElement | null }) {
  const [hint, setHint] = useState<Hint | null>(null);

  useEffect(() => {
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const over = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a[href]");
      if (!a) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const href = a.getAttribute("href") ?? "";
        let host = href;
        try {
          const url = new URL(href);
          host = url.protocol === "mailto:" ? url.pathname : url.host;
        } catch {
          /* show raw */
        }
        const r = a.getBoundingClientRect();
        setHint({
          host,
          left: Math.max(6, Math.min(r.left, window.innerWidth - 200)),
          top: r.bottom + 6,
        });
      }, 500);
    };
    const out = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest("a[href]")) {
        clearTimeout(timer);
        setHint(null);
      }
    };
    container.addEventListener("mouseover", over);
    container.addEventListener("mouseout", out);
    return () => {
      clearTimeout(timer);
      container.removeEventListener("mouseover", over);
      container.removeEventListener("mouseout", out);
    };
  }, [container]);

  if (!hint) return null;
  return (
    <div role="tooltip" className="dn-tooltip dn-link-hint" style={{ left: hint.left, top: hint.top }}>
      <span className="dn-tooltip-strong">{isMac ? "⌘+click to open" : "Ctrl+click to open"}</span>
      <span className="dn-tooltip-sub">{hint.host}</span>
    </div>
  );
}
