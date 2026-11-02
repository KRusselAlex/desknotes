// Key combinations for the "Show / hide all notes" shortcut, in GNOME's
// accelerator text (`<Control><Alt>n`). Must accept the same keys as
// `Accel::parse` in src-tauri/src/platform/gnome_shortcut.rs.

export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** A usable combination, an explanation of why not, or null while only modifiers are held. */
export type Captured = { accel: string; label: string } | { error: string } | null;

const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "Super", "Hyper", "OS"]);
const MODS: [keyof KeyPress & `${string}Key`, string, string][] = [
  ["ctrlKey", "<Control>", "Ctrl"],
  ["altKey", "<Alt>", "Alt"],
  ["shiftKey", "<Shift>", "Shift"],
  ["metaKey", "<Super>", "Super"],
];

/** GNOME's name for the key, or null if not supported (letters, digits, F1–F12, Space). */
function keyName(e: KeyPress): string | null {
  // Numpad digits are different keys from the top-row ones GNOME would bind.
  if (e.code.startsWith("Numpad")) return null;
  // The typed character, so layouts like AZERTY get what is printed on the key…
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toLowerCase();
  // …unless Ctrl+Alt made it a symbol (AltGr layouts): then the physical key.
  const letter = /^Key([A-Z])$/.exec(e.code) ?? /^Digit([0-9])$/.exec(e.code);
  if (letter) return letter[1]!.toLowerCase();
  if (e.code === "Space") return "space";
  const f = /^F([0-9]{1,2})$/.exec(e.code);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return `F${f[1]}`;
  return null;
}

function keyLabel(name: string): string {
  return name === "space" ? "Space" : name.toUpperCase();
}

export function accelFromKey(e: KeyPress): Captured {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const name = keyName(e);
  if (!name) return { error: "This key can't be used." };
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return { error: "Use Ctrl, Alt or Super with the key." };
  const on = MODS.filter(([flag]) => e[flag]);
  return {
    accel: on.map(([, text]) => text).join("") + name,
    label: [...on.map(([, , label]) => label), keyLabel(name)].join("+"),
  };
}

