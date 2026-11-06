import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons";
import { Menu, type MenuItem } from "../../components/Menu";
import type { Appearance } from "../../types/note";
import { pickImage, type ImageProblem } from "./imageInput";
import { TextStylePopover } from "./TextStylePopover";

export type ListType = "taskList" | "bulletList" | "orderedList";

const LIST_TYPES: { type: ListType; label: string; icon: IconName; shortcut: string }[] = [
  { type: "taskList", label: "Checklist", icon: "checklist", shortcut: "Ctrl+Shift+9" },
  { type: "bulletList", label: "Bulleted list", icon: "bullets", shortcut: "Ctrl+Shift+8" },
  { type: "orderedList", label: "Numbered list", icon: "numbered", shortcut: "Ctrl+Shift+7" },
];

function toggleList(editor: Editor, type: ListType) {
  const chain = editor.chain().focus();
  if (type === "taskList") chain.toggleTaskList().run();
  else if (type === "bulletList") chain.toggleBulletList().run();
  else chain.toggleOrderedList().run();
}

interface ToolProps {
  label: string;
  icon: IconName;
  title?: string;
  active?: boolean;
  onPress: () => void;
}

function Tool({ label, icon, title, active, onPress }: ToolProps) {
  return (
    <button
      type="button"
      className="dn-tool"
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onPress}
    >
      <Icon name={icon} stroke={active ? 2.75 : 2.25} />
    </button>
  );
}

type Open = "none" | "lists" | "overflow" | "textStyle";

/** Bottom formatting bar shown while editing (design N2, N12, N14, N15). */
export function FormatBar({
  editor,
  narrow,
  appearance,
  onLink,
  noteId,
  onImageProblem,
}: {
  editor: Editor;
  narrow: boolean;
  appearance: Appearance;
  onLink: () => void;
  noteId: string;
  /** An image could not be added (NoteWindow shows the message). */
  onImageProblem: (problem: ImageProblem) => void;
}) {
  const [open, setOpen] = useState<Open>("none");
  const [lastList, setLastList] = useState<ListType>("taskList");
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      heading: e.isActive("heading"),
      link: e.isActive("link"),
      list: (["taskList", "bulletList", "orderedList"] as const).find((t) => e.isActive(t)) ?? null,
    }),
  });
  const run = () => editor.chain().focus();
  const shownList = s.list ?? lastList;
  const listIcon = LIST_TYPES.find((l) => l.type === shownList)?.icon ?? "checklist";

  const listItems: MenuItem[] = LIST_TYPES.map((l) => ({
    id: l.type,
    label: l.label,
    icon: l.icon,
    shortcut: l.shortcut,
    checked: s.list === l.type,
    onSelect: () => {
      setLastList(l.type);
      toggleList(editor, l.type);
    },
  }));

  const insertImage = () => void pickImage(editor, noteId, onImageProblem);

  // Below 260 px the bar has no room for one more button: Insert image… waits here.
  const overflowItems: MenuItem[] = [
    { id: "underline", label: "Underline", icon: "underline", shortcut: "Ctrl+U", onSelect: () => run().toggleUnderline().run() },
    { id: "strike", label: "Strikethrough", icon: "strike", onSelect: () => run().toggleStrike().run() },
    { id: "heading", label: "Heading", icon: "heading", onSelect: () => run().toggleHeading({ level: 2 }).run() },
    { id: "textStyle", label: "Text style…", icon: "type", onSelect: () => setOpen("textStyle") },
    { id: "image", label: "Insert image…", icon: "image", onSelect: insertImage },
  ];

  const close = () => {
    setOpen("none");
    editor.commands.focus();
  };
  // The menu closes itself after any item; "Text style…" has just replaced it by the popover.
  const closeOverflow = () => {
    setOpen((o) => (o === "overflow" ? "none" : o));
    editor.commands.focus();
  };

  return (
    <div className="dn-format-bar" role="toolbar" aria-label="Formatting">
      {!narrow && (
        <Tool label="Heading" icon="heading" title="Heading (Ctrl+Alt+1–3)" active={s.heading} onPress={() => run().toggleHeading({ level: 2 }).run()} />
      )}
      <button
        type="button"
        className="dn-tool dn-tool-wide"
        aria-label="List type"
        title="List type"
        aria-haspopup="menu"
        aria-expanded={open === "lists"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(open === "lists" ? "none" : "lists")}
        data-popover-toggle
      >
        <Icon name={listIcon} />
        <Icon name="chevdown" size={12} />
      </button>
      <Tool label="Bold" icon="bold" title="Bold (Ctrl+B)" active={s.bold} onPress={() => run().toggleBold().run()} />
      <Tool label="Italic" icon="italic" title="Italic (Ctrl+I)" active={s.italic} onPress={() => run().toggleItalic().run()} />
      {!narrow && (
        <>
          <Tool label="Underline" icon="underline" title="Underline (Ctrl+U)" active={s.underline} onPress={() => run().toggleUnderline().run()} />
          <Tool label="Strikethrough" icon="strike" title="Strikethrough (Ctrl+Shift+S)" active={s.strike} onPress={() => run().toggleStrike().run()} />
        </>
      )}
      <Tool label="Link" icon="link" title="Link (Ctrl+K)" active={s.link} onPress={onLink} />
      {!narrow && <Tool label="Insert image…" icon="image" onPress={insertImage} />}
      {!narrow && (
        <>
          <span className="dn-format-divider" aria-hidden="true" />
          <button
            type="button"
            className="dn-tool dn-tool-text"
            aria-label="Text style"
            title="Text style"
            aria-haspopup="dialog"
            aria-expanded={open === "textStyle"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (open === "textStyle" ? close() : setOpen("textStyle"))}
            data-popover-toggle
          >
            Aa
          </button>
        </>
      )}
      {narrow && (
        <>
          <span className="dn-spacer" />
          <button
            type="button"
            className="dn-tool"
            aria-label="More formatting"
            aria-haspopup="menu"
            aria-expanded={open === "overflow"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen(open === "overflow" ? "none" : "overflow")}
            data-popover-toggle
          >
            <Icon name="chevup" />
          </button>
        </>
      )}

      {open === "lists" && (
        <Menu label="List type" radio items={listItems} onClose={close} className="dn-menu-lists" />
      )}
      {open === "overflow" && (
        <Menu label="More formatting" items={overflowItems} onClose={closeOverflow} className="dn-menu-overflow" />
      )}
      {open === "textStyle" && <TextStylePopover editor={editor} appearance={appearance} onClose={close} />}
    </div>
  );
}
