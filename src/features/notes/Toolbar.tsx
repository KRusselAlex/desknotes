import { useEditorState, type Editor } from "@tiptap/react";
import type { ReactNode } from "react";

interface ButtonProps {
  label: string;
  shortcut?: string;
  active?: boolean;
  onPress: () => void;
  children: ReactNode;
}

function ToolButton({ label, shortcut, active, onPress, children }: ButtonProps) {
  return (
    <button
      type="button"
      className="tool"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active}
      // Keep the editor selection: act on mousedown without stealing focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

export function FormatToolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      heading: e.isActive("heading"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      link: e.isActive("link"),
    }),
  });
  const run = () => editor.chain().focus();

  return (
    <div className="format-toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton label="Bold" shortcut="Ctrl+B" active={s.bold} onPress={() => run().toggleBold().run()}>
        <b>B</b>
      </ToolButton>
      <ToolButton label="Italic" shortcut="Ctrl+I" active={s.italic} onPress={() => run().toggleItalic().run()}>
        <i>I</i>
      </ToolButton>
      <ToolButton label="Underline" shortcut="Ctrl+U" active={s.underline} onPress={() => run().toggleUnderline().run()}>
        <u>U</u>
      </ToolButton>
      <ToolButton label="Strikethrough" shortcut="Ctrl+Shift+S" active={s.strike} onPress={() => run().toggleStrike().run()}>
        <s>S</s>
      </ToolButton>
      <ToolButton label="Heading" shortcut="Ctrl+Alt+2" active={s.heading} onPress={() => run().toggleHeading({ level: 2 }).run()}>
        H
      </ToolButton>
      <ToolButton label="Bulleted list" shortcut="Ctrl+Shift+8" active={s.bullet} onPress={() => run().toggleBulletList().run()}>
        •
      </ToolButton>
      <ToolButton label="Numbered list" shortcut="Ctrl+Shift+7" active={s.ordered} onPress={() => run().toggleOrderedList().run()}>
        1.
      </ToolButton>
      <ToolButton label="Checklist" shortcut="Ctrl+Shift+9" active={s.task} onPress={() => run().toggleTaskList().run()}>
        ☑
      </ToolButton>
      <ToolButton label="Link" shortcut="Ctrl+K" active={s.link} onPress={onLink}>
        🔗
      </ToolButton>
    </div>
  );
}
