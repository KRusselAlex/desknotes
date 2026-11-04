import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { createExtensions } from "./extensions";

vi.mock("../../ipc/commands", () => ({
  commands: { listFonts: vi.fn(() => Promise.resolve(["Amiri"])) },
}));

import { FormatBar } from "./FormatBar";

let editor: Editor;
beforeEach(() => {
  editor = new Editor({ extensions: createExtensions(), content: "<p>Hello world</p>" });
});
afterEach(() => editor.destroy());

function renderBar(narrow: boolean) {
  return render(<FormatBar editor={editor} narrow={narrow} appearance={{}} onLink={() => {}} />);
}

describe("FormatBar text style", () => {
  it("Aa opens the Text style popover", async () => {
    const user = userEvent.setup();
    renderBar(false);
    const aa = screen.getByRole("button", { name: "Text style" });
    expect(aa).toHaveTextContent("Aa");
    expect(aa).toHaveAttribute("aria-haspopup", "dialog");
    expect(aa).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Text style" })).not.toBeInTheDocument();

    await user.click(aa);
    expect(aa).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Text style" })).toBeInTheDocument();
    await screen.findByRole("option", { name: "Amiri" });

    // Aa again closes it.
    await user.click(aa);
    expect(aa).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Text style" })).not.toBeInTheDocument();
  });

  it("Escape closes the popover", async () => {
    const user = userEvent.setup();
    renderBar(false);
    await user.click(screen.getByRole("button", { name: "Text style" }));
    await screen.findByRole("option", { name: "Amiri" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Text style" })).not.toBeInTheDocument();
  });

  it("narrow bar offers Text style… in the overflow menu", async () => {
    const user = userEvent.setup();
    renderBar(true);
    expect(screen.queryByRole("button", { name: "Text style" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More formatting" }));
    await user.click(screen.getByRole("menuitem", { name: "Text style…" }));
    expect(screen.queryByRole("menu", { name: "More formatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Text style" })).toBeInTheDocument();
    await screen.findByRole("option", { name: "Amiri" });
  });
});
