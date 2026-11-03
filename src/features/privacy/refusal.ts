/** `CommandError.code` when a locked private note is asked to change (Rust `CoreError::PrivateLocked`). */
export const PRIVATE_LOCKED = "private_locked";

/** Shown instead of the native refusal, which names no way out. */
export const UNLOCK_FIRST = "Unlock private notes first.";

/**
 * The native side refused because private notes are locked (R11, R12, R21).
 * Matches the error's code, never its text. Takes the error a command rejected
 * with (a `CommandError`); anything without that code is not a lock refusal.
 */
export function isLockRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === PRIVATE_LOCKED;
}

/** The reason to show for a refused action: the lock in plain words, else the native message. */
export function refusalText(error: unknown): string {
  if (isLockRefusal(error)) return UNLOCK_FIRST;
  return error instanceof Error ? error.message : String(error);
}
