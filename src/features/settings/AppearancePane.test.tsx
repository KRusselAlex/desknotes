import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../ipc/commands", () => ({
  commands: { listFonts: vi.fn() },
}));

import { commands } from "../../ipc/commands";
import { APP_APPEARANCE_DEFAULTS, type AppAppearance } from "../../types/note";
import { AppearancePane } from "./AppearancePane";

const show = (value: Partial<AppAppearance> = {}) => {
  const onChange = vi.fn();
  render(<AppearancePane value={{ ...APP_APPEARANCE_DEFAULTS, ...value }} onChange={onChange} />);
  return onChange;
};

describe("AppearancePane", () => {
  beforeEach(() => {
    vi.mocked(commands.listFonts).mockResolvedValue(["Fira Sans", "Lora"]);
  });

  it("has the rows of design S4 in order", async () => {
    show();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("High-contrast notes")).toBeInTheDocument();
    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByText("Default font")).toBeInTheDocument();
    expect(screen.getByText("Default size")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset appearance" })).toBeInTheDocument();
    const layout = screen.getByRole("radiogroup", { name: "Layout" });
    expect(within(layout).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Compact", "Comfortable"]);
    await screen.findByRole("option", { name: "Lora" });
  });

  it("puts its rows in one card, like the other panes", async () => {
    show();
    const card = screen.getByRole("switch", { name: "High-contrast notes" }).closest(".dn-card");
    expect(card).not.toBeNull();
    for (const label of ["High-contrast notes", "Layout", "Default font", "Default size"]) {
      expect(within(card as HTMLElement).getByText(label)).toHaveClass("dn-card-label");
    }
    expect(card?.querySelectorAll(".dn-card-row")).toHaveLength(5); // four settings and Reset
    expect(within(card as HTMLElement).getByRole("button", { name: "Reset appearance" })).toBeInTheDocument();
    await screen.findByRole("option", { name: "Lora" });
  });

  it("reports one change at a time, as the whole value", async () => {
    const onChange = show({ defaultSize: 20 });
    await userEvent.click(screen.getByRole("switch", { name: "High-contrast notes" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...APP_APPEARANCE_DEFAULTS, defaultSize: 20, highContrast: true });
    await userEvent.click(screen.getByRole("radio", { name: "Compact" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...APP_APPEARANCE_DEFAULTS, defaultSize: 20, layout: "compact" });
    await userEvent.click(screen.getByRole("button", { name: "Smaller default size" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...APP_APPEARANCE_DEFAULTS, defaultSize: 19 });
  });

  it("does not report the layout already chosen", async () => {
    const onChange = show();
    await userEvent.click(screen.getByRole("radio", { name: "Comfortable" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables the stepper at 10 and at 32", () => {
    const { unmount } = render(<AppearancePane value={{ ...APP_APPEARANCE_DEFAULTS, defaultSize: 10 }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Smaller default size" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Larger default size" })).toBeEnabled();
    unmount();
    render(<AppearancePane value={{ ...APP_APPEARANCE_DEFAULTS, defaultSize: 32 }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Larger default size" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Smaller default size" })).toBeEnabled();
  });

  it("keeps a font that is no longer installed visible and says so", async () => {
    show({ defaultFont: "Gone Sans" });
    expect(await screen.findByRole("option", { name: "Gone Sans (not installed)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default font" })).toHaveValue("Gone Sans");
  });

  it("still works when the font list cannot be read", async () => {
    vi.mocked(commands.listFonts).mockRejectedValue(new Error("no fonts"));
    show();
    const select = screen.getByRole("combobox", { name: "Default font" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["System default"]);
  });
});
