import { useState, type KeyboardEvent } from "react";
import type { Editor } from "@tiptap/react";
import { normalizeLink } from "./links";

/** Small inline field to add, change or remove the link on the selection. */
export function LinkEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [value, setValue] = useState<string>(() => editor.getAttributes("link").href ?? "");
  const [invalid, setInvalid] = useState(false);

  function apply() {
    if (!value.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      onClose();
      return;
    }
    const href = normalizeLink(value);
    if (!href) {
      setInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    onClose();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editor.commands.focus();
      onClose();
    }
  }

  return (
    <div className="link-editor">
      <input
        autoFocus
        aria-label="Link address"
        aria-invalid={invalid}
        placeholder="https://… (empty removes the link)"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={onKeyDown}
      />
      {invalid && <span role="alert">Only web and email links are allowed.</span>}
    </div>
  );
}
