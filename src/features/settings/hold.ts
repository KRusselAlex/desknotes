import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";

/**
 * Keeps Settings where it is (R25): while held, the section nav is inert and a
 * section asked for by another window waits. Held while a recovery code is on
 * screen and while a call that may issue one (or change the PIN) is running.
 * Every `hold(true)` is matched by one `hold(false)`.
 */
export const SettingsHold = createContext<(on: boolean) => void>(() => undefined);

export function useSettingsHold(): (on: boolean) => void {
  return useContext(SettingsHold);
}

/** Holds Settings from the commit in which `active` becomes true until it is false or unmounted. */
export function useHoldWhile(active: boolean) {
  const hold = useSettingsHold();
  useLayoutEffect(() => {
    if (!active) return;
    hold(true);
    return () => hold(false);
  }, [active, hold]);
}

/** Runs `call` with Settings held (synchronously from the start, so no event slips in first). */
export async function holding<T>(hold: (on: boolean) => void, call: () => Promise<T>): Promise<T> {
  hold(true);
  try {
    return await call();
  } finally {
    hold(false);
  }
}

/**
 * For a dialog that runs a call which may return a recovery code it then shows as `code`.
 * The returned runner holds Settings from the start of the call; when the call issued a
 * code, the hold is kept until the commit that puts the code on screen (where the code
 * view holds by itself), so there is no moment without a hold in between.
 */
export function useIssuingHold(code: string | null) {
  const hold = useSettingsHold();
  const handOver = useRef(false);
  useLayoutEffect(() => {
    if (code !== null && handOver.current) {
      handOver.current = false;
      hold(false);
    }
  }, [code, hold]);
  useLayoutEffect(
    () => () => {
      if (handOver.current) {
        handOver.current = false;
        hold(false);
      }
    },
    [hold],
  );
  return useCallback(
    async <T>(call: () => Promise<T>, issued: (result: T) => boolean): Promise<T> => {
      hold(true);
      let kept = false;
      try {
        const result = await call();
        if (issued(result)) {
          kept = true;
          handOver.current = true;
        }
        return result;
      } finally {
        if (!kept) hold(false);
      }
    },
    [hold],
  );
}
