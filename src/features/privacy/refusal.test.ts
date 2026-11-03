import { CommandError } from "../../ipc/commands";
import { UNLOCK_FIRST, isLockRefusal, refusalText } from "./refusal";

describe("lock refusals", () => {
  it("are recognised by the private_locked code", () => {
    const locked = new CommandError("private_locked", "private notes are locked");
    expect(isLockRefusal(locked)).toBe(true);
    expect(refusalText(locked)).toBe(UNLOCK_FIRST);
  });

  it("are not recognised by their words", () => {
    for (const other of [
      new CommandError("not_allowed", "operation not allowed: private notes are locked"),
      new Error("private notes are locked"),
      "private notes are locked",
      null,
      undefined,
    ]) {
      expect(isLockRefusal(other)).toBe(false);
    }
    expect(refusalText(new CommandError("not_allowed", "restore the note from the trash first"))).toBe(
      "restore the note from the trash first",
    );
  });
});
