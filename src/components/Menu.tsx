import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

interface MenuItemBase {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  danger?: boolean;
  /** For radio-style items (list type) and checkable items; on an item with a submenu, a check shows. */
  checked?: boolean;
  /** On/off item (role menuitemcheckbox), e.g. "Always on top". */
  checkable?: boolean;
  separatorBefore?: boolean;
}

/** An action, or a parent that opens its submenu in place of the list, under a back row named like it. */
export type MenuItem = MenuItemBase &
  ({ onSelect: () => void; submenu?: never } | { submenu: MenuItem[]; onSelect?: never });

/** A button of the quick-action row: an icon over a short label. */
export interface QuickAction {
  id: string;
  /** Short visible label under the icon ("On top"). */
  label: string;
  /** Accessible name: the full action ("Always on top"). */
  name: string;
  icon: IconName;
  title?: string;
  /** On/off toggle (role menuitemcheckbox): it keeps the menu open, so the change is seen. */
  checkable?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  label: string;
  items: MenuItem[];
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
  radio?: boolean;
  /** A row of buttons above the list (the note menu, DES-38). */
  quick?: QuickAction[];
}

const focusable = (root: HTMLElement | null, selector: string) =>
  Array.from(root?.querySelectorAll<HTMLElement>(selector) ?? []);

/**
 * Keyboard-navigable popup menu: arrows move, Enter selects, Esc closes. With a quick row,
 * ←/→ move along it and ↓/↑ go between it and the list. An item with a submenu opens it in
 * place (Enter or →); ← or Esc goes back to the list.
 */
export function Menu({ label, items, onClose, className, style, radio, quick }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  /** The item whose submenu is shown, or null for the main list. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Where focus goes after the list changes: the first sub-item, or the parent on return. */
  const focusAfter = useRef<"first-sub" | string | null>(null);
  /** The quick button ↓ left from, so ↑ from the list comes back to it. */
  const lastQuick = useRef(0);

  const parent = openId === null ? undefined : items.find((i) => i.id === openId && i.submenu);
  const shown = parent?.submenu ?? items;

  /** Read once: focus is placed only on opening, so a toggle that turns on does not move it. */
  const startOnQuick = useRef(Boolean(quick?.length));

  useEffect(() => {
    const first = startOnQuick.current
      ? ref.current?.querySelector<HTMLElement>("[data-menu-quick]")
      : (ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        ref.current?.querySelector<HTMLElement>("[data-menu-item]"));
    first?.focus();
  }, []);

  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const nodes = focusable(ref.current, "[data-menu-item]");
    if (target === "first-sub") (nodes[1] ?? nodes[0])?.focus();
    else nodes.find((n) => n.dataset.menuId === target)?.focus();
  }, [openId]);

  function openSub(item: MenuItem) {
    focusAfter.current = "first-sub";
    setOpenId(item.id);
  }

  function back() {
    focusAfter.current = openId;
    setOpenId(null);
  }

  function onKeyDown(e: KeyboardEvent) {
    const row = parent ? [] : focusable(ref.current, "[data-menu-quick]");
    const list = focusable(ref.current, "[data-menu-item]");
    const active = document.activeElement as HTMLElement;
    const q = row.indexOf(active);
    const i = list.indexOf(active);
    const focusRow = (n: number) => {
      lastQuick.current = (n + row.length) % row.length;
      row[lastQuick.current]?.focus();
    };
    const focusList = (n: number) => list[(n + list.length) % list.length]?.focus();

    if (q >= 0) {
      if (e.key === "ArrowLeft") focusRow(q - 1);
      else if (e.key === "ArrowRight") focusRow(q + 1);
      else if (e.key === "ArrowDown") {
        lastQuick.current = q;
        focusList(0);
      } else if (e.key === "ArrowUp") {
        lastQuick.current = q;
        focusList(-1);
      } else if (e.key === "Home") focusRow(0);
      else if (e.key === "End") focusList(-1);
      else if (e.key === "Escape" || e.key === "Tab") onClose();
      else return;
    } else {
      const item = shown.find((it) => it.id === active?.dataset.menuId);
      if (e.key === "ArrowDown") {
        if (i === list.length - 1 && row.length) focusRow(lastQuick.current);
        else focusList(i + 1);
      } else if (e.key === "ArrowUp") {
        if (i === 0 && row.length) focusRow(lastQuick.current);
        else focusList(i < 0 ? -1 : i - 1);
      } else if (e.key === "Home") {
        if (row.length) focusRow(0);
        else focusList(0);
      } else if (e.key === "End") focusList(-1);
      else if (e.key === "ArrowRight" && !parent && item?.submenu) openSub(item);
      else if ((e.key === "ArrowLeft" || e.key === "Escape") && parent) back();
      else if (e.key === "Escape" || e.key === "Tab") onClose();
      else return;
    }
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
      {!parent && quick && quick.length > 0 && (
        <>
          <div role="group" aria-label="Quick actions" className="dn-menu-quick">
            {quick.map((action) => (
              <button
                key={action.id}
                type="button"
                data-menu-quick
                role={action.checkable ? "menuitemcheckbox" : "menuitem"}
                aria-checked={action.checkable ? Boolean(action.checked) : undefined}
                aria-label={action.name}
                title={action.title ?? action.name}
                className="dn-menu-quick-btn"
                onClick={() => {
                  action.onSelect();
                  if (!action.checkable) onClose();
                }}
              >
                <Icon name={action.icon} size={16} />
                <span className="dn-menu-quick-label">{action.label}</span>
              </button>
            ))}
          </div>
          <div className="dn-menu-sep" role="separator" />
        </>
      )}
      {parent && (
        <button
          type="button"
          data-menu-item
          data-menu-id={`${parent.id}:back`}
          role="menuitem"
          aria-label={`${parent.label}, back`}
          className="dn-menu-item dn-menu-back"
          onClick={back}
        >
          <Icon name="chevright" size={15} className="dn-menu-back-icon" />
          <span className="dn-menu-label">{parent.label}</span>
        </button>
      )}
      {shown.map((item) => (
        <div key={item.id} style={{ display: "contents" }}>
          {item.separatorBefore && <div className="dn-menu-sep" role="separator" />}
          <button
            type="button"
            data-menu-item
            data-menu-id={item.id}
            role={radio ? "menuitemradio" : item.checkable ? "menuitemcheckbox" : "menuitem"}
            aria-checked={radio || item.checkable ? Boolean(item.checked) : undefined}
            aria-haspopup={item.submenu ? "menu" : undefined}
            className={`dn-menu-item${item.danger ? " is-danger" : ""}`}
            onClick={() => {
              if (item.submenu) {
                openSub(item);
                return;
              }
              item.onSelect();
              onClose();
            }}
          >
            {item.icon && <Icon name={item.icon} size={15} />}
            <span className="dn-menu-label">{item.label}</span>
            {item.shortcut && <span className="dn-menu-shortcut">{item.shortcut}</span>}
            {(item.checkable || item.submenu) && item.checked && <Icon name="check" size={14} stroke={2.75} />}
            {item.submenu && <Icon name="chevright" size={14} className="dn-menu-chevron" />}
          </button>
        </div>
      ))}
    </div>
  );
}
