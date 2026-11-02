import { useEffect, useRef, type ReactNode } from "react";

/**
 * Modal dialog in the S3 style (backdrop, raised card). Focus moves to the dialog
 * itself, not to a button, so digits typed for a PIN and Enter never press Cancel.
 * Escape calls `onEscape` when given.
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
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="dn-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onEscape?.()}>
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
