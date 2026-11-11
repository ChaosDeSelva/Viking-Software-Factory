// Polling that never lets an older answer overwrite a newer one, free of React so node --test covers it.

/** How long one load may take before it counts as failed and the next tick may load again. */
export const POLL_TIMEOUT_MS = 15_000;

/**
 * `tick` loads once and hands the answer to `apply` or the failure to `fail`. A tick while a load
 * is still in flight is skipped, so answers arrive in order; a load that outlasts POLL_TIMEOUT_MS
 * fails and its late answer is dropped; nothing is handed on after `stop`.
 */
export function poller<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  fail: (error: Error) => void,
): { tick: () => void; stop: () => void } {
  let stopped = false,
    busy = false,
    current = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  return {
    tick() {
      if (stopped || busy) return;
      busy = true;
      const id = ++current;
      // Settles once, by the load or the timeout, whichever comes first.
      const settle = (handle: () => void) => {
        if (id !== current || !busy) return;
        clearTimeout(timer);
        busy = false;
        if (!stopped) handle();
      };
      timer = setTimeout(
        () =>
          settle(() =>
            fail(Error(`Timed out after ${POLL_TIMEOUT_MS / 1000} s`)),
          ),
        POLL_TIMEOUT_MS,
      );
      load().then(
        (value) => settle(() => apply(value)),
        (error) => settle(() => fail(error)),
      );
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
