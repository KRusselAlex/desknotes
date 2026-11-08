import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Modal dialog in the S3 style (backdrop, raised card). Focus moves to the dialog
 * itself, not to a button, so digits typed for a PIN and Enter never press Cancel.
 * Tab and Shift+Tab stay inside the dialog (skipping controls kept out of the Tab order);
 * on close, focus goes back to the control that was focused when it opened. If the
 * focused control goes away (a step changes), focus goes back to the dialog, where
 * Escape and Tab still work. Escape calls `onEscape` when given.
 */
export function Dialog({
  titleId,
  onEscape,
  className,
  children,
}: {
  titleId: string;
  onEscape?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (!active || active === document.body) dialog.focus();
    });
    observer.observe(dialog, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      onEscape?.();
      return;
    }
    if (e.key !== "Tab") return;
    const dialog = ref.current;
    if (!dialog) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0);
    e.preventDefault();
    if (items.length === 0) {
      dialog.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    let at = items.indexOf(active as HTMLElement);
    if (at === -1 && active && active !== dialog && dialog.contains(active)) {
      // Focus is on a control kept out of the Tab order (an option the arrows moved to):
      // go on from where it stands, as the browser would.
      const after = items.findIndex((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      at = e.shiftKey ? (after === -1 ? items.length : after) : (after === -1 ? items.length : after) - 1;
    }
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1;
    items[next]!.focus();
  }

  return (
    <div
      className="dn-modal-backdrop"
      onKeyDown={onKeyDown}
      // A click on the backdrop keeps focus in the dialog.
      onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
    >
      <div
        ref={ref}
        className={`dn-modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
