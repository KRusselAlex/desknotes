import { useState, type KeyboardEvent } from "react";
import type { Editor } from "@tiptap/react";
import { Icon } from "../../components/Icon";
import { normalizeLink } from "./links";

/** Inline strip under the header to add, change or remove a link (design N10). */
export function LinkEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const existing: string = editor.getAttributes("link").href ?? "";
  const [value, setValue] = useState(existing);
  const [invalid, setInvalid] = useState(false);

  function apply() {
    if (!value.trim()) {
      remove();
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

  function remove() {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
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
    <div className="dn-link-editor">
      <div className="dn-link-row">
        <label className={`dn-link-field${invalid ? " is-invalid" : ""}`}>
          <Icon name="link" size={14} />
          <input
            autoFocus
            aria-label="Link address"
            aria-invalid={invalid}
            aria-describedby={invalid ? "link-error" : undefined}
            placeholder="https://…"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        <button type="button" className="dn-round dn-round-ink" aria-label="Apply link" onClick={apply}>
          <Icon name="check" size={15} stroke={2.75} />
        </button>
        {existing && (
          <button type="button" className="dn-round" aria-label="Remove link" onClick={remove}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
      {invalid && (
        <div id="link-error" role="alert" className="dn-link-error">
          <Icon name="alert" size={13} />
          Use a web (https://…) or e-mail address.
        </div>
      )}
    </div>
  );
}
