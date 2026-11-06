// Where the editor loads stored images from. Lives in src/ipc with the commands:
// the address is made by the native `desknotes-image` scheme (src-tauri/src/commands/images.rs).

import { convertFileSrc } from "@tauri-apps/api/core";

const SCHEME = "desknotes-image";

let resolver: (id: string) => string = (id) => convertFileSrc(id, SCHEME);

/** The address of a stored image. Only a 64-hex id is ever served. */
export function imageUrl(id: string): string {
  return resolver(id);
}

/** For the browser preview only (src/dev/preview.tsx), where the native scheme does not exist. */
export function setImageUrlResolver(next: (id: string) => string): void {
  resolver = next;
}
