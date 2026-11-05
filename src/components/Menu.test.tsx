import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Menu, type MenuItem, type QuickAction } from "./Menu";

const plain = (onSelect = vi.fn()): MenuItem[] => [
  { id: "a", label: "Alpha", onSelect },
  { id: "b", label: "Beta", onSelect },
  { id: "c", label: "Gamma", separatorBefore: true, onSelect },
];

describe("Menu (plain list, as FormatBar and the manager use it)", () => {
  it("focuses the first item, moves with the arrows, Home and End, wraps, and closes on Escape and Tab", async () => {
    const onClose = vi.fn();
    render(<Menu label="Things" items={plain()} onClose={onClose} />);
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Beta" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("selects and closes on click; a radio menu starts on its checked item", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items: MenuItem[] = [
      { id: "a", label: "Bullets", checked: false, onSelect },
      { id: "b", label: "Numbers", checked: true, onSelect },
    ];
    render(<Menu label="List type" radio items={items} onClose={onClose} />);
    expect(screen.getByRole("menuitemradio", { name: "Numbers" })).toHaveFocus();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Bullets" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/** A menu with a quick row whose toggles really flip, as NoteWindow drives it. */
function QuickMenu({ onNew, onClose, subSelect }: { onNew: () => void; onClose: () => void; subSelect: () => void }) {
  const [pinned, setPinned] = useState(false);
  const [locked, setLocked] = useState(true);
  const [isPrivate, setPrivate] = useState(false);
  const quick: QuickAction[] = [
    { id: "new", label: "New", name: "New note", icon: "plus", title: "New note (Ctrl+N)", onSelect: onNew },
    { id: "dup", label: "Duplicate", name: "Duplicate", icon: "duplicate", onSelect: onNew },
    { id: "pin", label: "On top", name: "Always on top", icon: "pin", checkable: true, checked: pinned, onSelect: () => setPinned(!pinned) },
    {
      id: "lock",
      label: "Lock",
      name: "Lock editing",
      icon: "editlock",
      title: locked ? "Allow editing" : "Lock editing",
      checkable: true,
      checked: locked,
      onSelect: () => setLocked(!locked),
    },
  ];
  const items: MenuItem[] = [
    { id: "reminder", label: "Set reminder…", icon: "bell", onSelect: vi.fn() },
    {
      id: "private",
      label: "Private",
      icon: "lock",
      checked: isPrivate,
      submenu: [
        { id: "make", label: "Make private", icon: "lock", onSelect: () => (setPrivate(true), subSelect()) },
        { id: "other", label: "Something else", onSelect: vi.fn() },
      ],
    },
    { id: "trash", label: "Move to trash", icon: "trash", danger: true, separatorBefore: true, onSelect: vi.fn() },
  ];
  return <Menu label="Note actions" quick={quick} items={items} onClose={onClose} />;
}

function renderQuick() {
  const onNew = vi.fn();
  const onClose = vi.fn();
  const subSelect = vi.fn();
  render(<QuickMenu onNew={onNew} onClose={onClose} subSelect={subSelect} />);
  return { onNew, onClose, subSelect };
}

describe("Menu quick-action row", () => {
  it("is a group of buttons named by their full action, with short visible labels and tooltips", () => {
    renderQuick();
    const row = screen.getByRole("group", { name: "Quick actions" });
    const buttons = Array.from(row.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["New note", "Duplicate", "Always on top", "Lock editing"]);
    expect(buttons.map((b) => b.textContent)).toEqual(["New", "Duplicate", "On top", "Lock"]);
    expect(within(row).getByRole("menuitem", { name: "New note" })).toHaveAttribute("title", "New note (Ctrl+N)");
    expect(within(row).getByRole("menuitemcheckbox", { name: "Lock editing" })).toHaveAttribute("title", "Allow editing");
    expect(buttons.every((b) => b.querySelector("svg") !== null)).toBe(true);
  });

  it("starts on the first quick button, even when a toggle is on", () => {
    renderQuick();
    expect(screen.getByRole("menuitem", { name: "New note" })).toHaveFocus();
  });

  it("flips a toggle and stays open; an action selects and closes", async () => {
    const { onNew, onClose } = renderQuick();
    const pin = screen.getByRole("menuitemcheckbox", { name: "Always on top" });
    expect(pin).toHaveAttribute("aria-checked", "false");
    await userEvent.click(pin);
    expect(pin).toHaveAttribute("aria-checked", "true");
    const lock = screen.getByRole("menuitemcheckbox", { name: "Lock editing" });
    await userEvent.click(lock);
    expect(lock).toHaveAttribute("aria-checked", "false");
    expect(lock).toHaveAttribute("title", "Lock editing");
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("menuitem", { name: "New note" }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles from the keyboard with Space and Enter, keeping focus on the toggle", async () => {
    const { onClose } = renderQuick();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    const pin = screen.getByRole("menuitemcheckbox", { name: "Always on top" });
    expect(pin).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(pin).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Enter}");
    expect(pin).toHaveAttribute("aria-checked", "false");
    expect(pin).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves along the row with ← and →, wrapping", async () => {
    renderQuick();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Lock editing" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "New note" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Lock editing" })).toHaveFocus();
  });

  it("↓ from the row goes to the first list item, ↑ from it back to the row; Home and End span both", async () => {
    renderQuick();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Set reminder…" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    // Back to the button the row was left from.
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Move to trash" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "New note" })).toHaveFocus();
  });

  it("Escape and Tab close it from the row", async () => {
    const { onClose } = renderQuick();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Menu drill-down", () => {
  async function toPrivate() {
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
  }

  it("marks the parent as opening a list, with a chevron", () => {
    renderQuick();
    const parent = screen.getByRole("menuitem", { name: "Private" });
    expect(parent).toHaveAttribute("aria-haspopup", "menu");
    expect(parent.querySelectorAll("svg")).toHaveLength(2); // its icon and the chevron, no check while off
  });

  it("shows a check after the parent while it is on, without making it a checkbox", () => {
    const items: MenuItem[] = [
      { id: "private", label: "Private", icon: "lock", checked: true, submenu: [{ id: "x", label: "Make not private", onSelect: vi.fn() }] },
    ];
    render(<Menu label="Note actions" items={items} onClose={vi.fn()} />);
    const parent = screen.getByRole("menuitem", { name: "Private" });
    expect(parent).not.toHaveAttribute("aria-checked");
    expect(parent.querySelectorAll("svg")).toHaveLength(3); // icon, check, chevron
  });

  it("opens in place with Enter, focusing the first sub-item, and comes back with Escape onto the parent", async () => {
    const { onClose } = renderQuick();
    await toPrivate();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Make private" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Quick actions" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Set reminder…" })).toBeNull();
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Private", "Make private", "Something else"]);
    expect(items[0]).toHaveAccessibleName("Private, back");

    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
    expect(screen.getByRole("group", { name: "Quick actions" })).toBeInTheDocument();
  });

  it("opens with → and comes back with ←; arrows wrap inside it", async () => {
    renderQuick();
    await toPrivate();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Make private" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Private, back" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Something else" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
  });

  it("→ and ← do nothing on ordinary items", async () => {
    renderQuick();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
    expect(screen.getByRole("menuitem", { name: "Set reminder…" })).toHaveFocus();
  });

  it("opens and goes back by click; a sub-item selects and closes the menu", async () => {
    const { onClose, subSelect } = renderQuick();
    await userEvent.click(screen.getByRole("menuitem", { name: "Private" }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "Private, back" }));
    expect(screen.getByRole("menuitem", { name: "Private" })).toHaveFocus();
    await userEvent.click(screen.getByRole("menuitem", { name: "Private" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Make private" }));
    expect(subSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab inside it closes the menu", async () => {
    const { onClose } = renderQuick();
    await toPrivate();
    await userEvent.keyboard("{Enter}{Tab}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
