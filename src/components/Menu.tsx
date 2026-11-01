import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  danger?: boolean;
  /** For radio-style items (list type). */
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  label: string;
  items: MenuItem[];
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  radio?: boolean;
}

/** Keyboard-navigable popup menu: arrows move, Enter selects, Esc closes. */
export function Menu({ label, items, onClose, className, style, radio }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first =
      ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      ref.current?.querySelector<HTMLElement>("[data-menu-item]");
    first?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => nodes[(i + nodes.length) % nodes.length]?.focus();
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(nodes.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`dn-menu dn-popover ${className ?? ""}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <div key={item.id} style={{ display: "contents" }}>
          {item.separatorBefore && <div className="dn-menu-sep" role="separator" />}
          <button
            type="button"
            data-menu-item
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? Boolean(item.checked) : undefined}
            className={`dn-menu-item${item.danger ? " is-danger" : ""}`}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon && <Icon name={item.icon} size={15} />}
            <span className="dn-menu-label">{item.label}</span>
            {item.shortcut && <span className="dn-menu-shortcut">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
