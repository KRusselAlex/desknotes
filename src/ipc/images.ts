// Where the editor loads stored images from. Lives in src/ipc with the commands:
// the address is made by the native `desknotes-image` scheme (src-tauri/src/commands/images.rs).

import { convertFileSrc } from "@tauri-apps/api/core";

const SCHEME = "desknotes-image";

let resolver: (id: string) => string = (id) => convertFileSrc(id, SCHEME);

/** The address of a stored image. Only a 64-hex id is ever served. */
export function imageUrl(id: string): string {
  return resolver(id);
}

/**
 * DeskNotes' own image addresses, as convertFileSrc makes them: `desknotes-image://localhost/<id>`
 * on Linux and macOS, `http(s)://desknotes-image.localhost/<id>` where the webview cannot use a
 * custom scheme (Windows, Android). Nothing may follow the id.
 */
const OWN_ADDRESS = /^(?:desknotes-image:\/\/localhost|https?:\/\/desknotes-image\.localhost)\/([0-9a-f]{64})$/;

/** The image id in one of DeskNotes' own image addresses; null for any other address. */
export function imageIdFromUrl(src: string): string | null {
  return OWN_ADDRESS.exec(src)?.[1] ?? null;
}

/** For the browser preview only (src/dev/preview.tsx), where the native scheme does not exist. */
export function setImageUrlResolver(next: (id: string) => string): void {
  resolver = next;
}
