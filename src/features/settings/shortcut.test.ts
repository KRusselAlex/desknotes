import { accelFromKey } from "./shortcut";

const key = (k: string, code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("accelFromKey", () => {
  it("turns Ctrl+Alt+N into GNOME's text and a readable label", () => {
    expect(accelFromKey(key("n", "KeyN", { ctrlKey: true, altKey: true }))).toEqual({
      accel: "<Control><Alt>n",
      label: "Ctrl+Alt+N",
    });
  });

  it("uses the typed letter, so AZERTY keyboards get what is printed on the key", () => {
    // On AZERTY the key at QWERTY's Q position types "a".
    expect(accelFromKey(key("a", "KeyQ", { ctrlKey: true, altKey: true }))).toMatchObject({ accel: "<Control><Alt>a" });
  });

  it("falls back to the physical key when Ctrl+Alt produces a symbol (AltGr layouts)", () => {
    expect(accelFromKey(key("€", "KeyE", { ctrlKey: true, altKey: true }))).toMatchObject({ accel: "<Control><Alt>e" });
    expect(accelFromKey(key("&", "Digit1", { ctrlKey: true, altKey: true }))).toMatchObject({ accel: "<Control><Alt>1" });
  });

  it("accepts F-keys, Space, Shift and Super", () => {
    expect(accelFromKey(key("F5", "F5", { metaKey: true }))).toEqual({ accel: "<Super>F5", label: "Super+F5" });
    expect(accelFromKey(key(" ", "Space", { ctrlKey: true, shiftKey: true }))).toEqual({
      accel: "<Control><Shift>space",
      label: "Ctrl+Shift+Space",
    });
  });

  it("waits while only modifiers are held", () => {
    expect(accelFromKey(key("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(accelFromKey(key("Alt", "AltLeft", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it("asks for Ctrl, Alt or Super", () => {
    expect(accelFromKey(key("n", "KeyN"))).toEqual({ error: "Use Ctrl, Alt or Super with the key." });
    expect(accelFromKey(key("N", "KeyN", { shiftKey: true }))).toEqual({ error: "Use Ctrl, Alt or Super with the key." });
  });

  it("refuses keys GNOME shortcuts here do not support", () => {
    expect(accelFromKey(key("Enter", "Enter", { ctrlKey: true }))).toEqual({ error: "This key can't be used." });
    expect(accelFromKey(key("F13", "F13", { ctrlKey: true }))).toEqual({ error: "This key can't be used." });
    // Numpad digits are other keys than the top-row ones GNOME would bind.
    expect(accelFromKey(key("5", "Numpad5", { ctrlKey: true }))).toEqual({ error: "This key can't be used." });
  });
});

