import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { createExtensions } from "./extensions";

vi.mock("../../ipc/commands", () => ({
  commands: { listFonts: vi.fn(() => Promise.resolve(["Amiri"])), pickImage: vi.fn() },
}));

import { commands } from "../../ipc/commands";
import { setImageUrlResolver } from "../../ipc/images";
import { FormatBar } from "./FormatBar";

setImageUrlResolver((id) => `desknotes-image://localhost/${id}`);

let editor: Editor;
beforeEach(() => {
  editor = new Editor({ extensions: createExtensions(), content: "<p>Hello world</p>" });
});
afterEach(() => editor.destroy());

const onImageProblem = vi.fn();

function renderBar(narrow: boolean) {
  return render(
    <FormatBar editor={editor} narrow={narrow} appearance={{}} onLink={() => {}} noteId="n1" onImageProblem={onImageProblem} />,
  );
}

const ID = "e".repeat(64);
const imageCount = () => JSON.stringify(editor.getJSON()).split('"type":"image"').length - 1;

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

  it("Esc and Aa give the focus back to the text (DES-33)", async () => {
    const user = userEvent.setup();
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.destroy();
    editor = new Editor({ element: host, extensions: createExtensions(), content: "<p>Hello world</p>" });
    try {
      renderBar(false);
      const aa = screen.getByRole("button", { name: "Text style" });
      for (const closeWith of [() => user.keyboard("{Escape}"), () => user.click(aa)]) {
        await user.click(aa);
        await screen.findByRole("option", { name: "Amiri" });
        screen.getByRole("combobox", { name: "Weight" }).focus(); // focus inside the popover
        await closeWith();
        expect(screen.queryByRole("dialog", { name: "Text style" })).not.toBeInTheDocument();
        await waitFor(() => expect(editor.view.dom).toHaveFocus());
      }
    } finally {
      host.remove();
    }
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

describe("FormatBar Insert image…", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sits right after Link, with its label as the tooltip", () => {
    renderBar(false);
    const tools = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(tools[tools.indexOf("Link") + 1]).toBe("Insert image…");
    expect(screen.getByRole("button", { name: "Insert image…" })).toHaveAttribute("title", "Insert image…");
  });

  it("calls pickImage and inserts the chosen image", async () => {
    vi.mocked(commands.pickImage).mockResolvedValue({ id: ID, width: 10, height: 10 });
    renderBar(false);
    await userEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    expect(commands.pickImage).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(imageCount()).toBe(1));
  });

  it("a null result inserts nothing", async () => {
    vi.mocked(commands.pickImage).mockResolvedValue(null);
    renderBar(false);
    await userEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    expect(commands.pickImage).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(imageCount()).toBe(0);
    expect(onImageProblem).not.toHaveBeenCalled();
  });

  it("a refused file reports the problem", async () => {
    vi.mocked(commands.pickImage).mockRejectedValue({ code: "image_too_large" });
    renderBar(false);
    await userEvent.click(screen.getByRole("button", { name: "Insert image…" }));
    await waitFor(() => expect(onImageProblem).toHaveBeenCalledWith("too_large"));
  });

  it("a narrow bar offers it in the overflow menu", async () => {
    vi.mocked(commands.pickImage).mockResolvedValue({ id: ID, width: 10, height: 10 });
    renderBar(true);
    expect(screen.queryByRole("button", { name: "Insert image…" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More formatting" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Insert image…" }));
    expect(commands.pickImage).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(imageCount()).toBe(1));
  });
});
