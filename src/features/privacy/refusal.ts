/** Message the native side gives when a locked private note is asked to change (Rust `PRIVATE_LOCKED`). */
const LOCKED = "private notes are locked";

/** Shown instead of the native refusal, which names no way out. */
export const UNLOCK_FIRST = "Unlock private notes first.";

/** The native side refused because private notes are locked (R11, R12, R21). Takes an error or its message. */
export function isLockRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.toLowerCase().includes(LOCKED);
}

/** The reason to show for a refused action: the lock in plain words, else the native message. */
export function refusalText(error: unknown): string {
  if (isLockRefusal(error)) return UNLOCK_FIRST;
  return error instanceof Error ? error.message : String(error);
}
