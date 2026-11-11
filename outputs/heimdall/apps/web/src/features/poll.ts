// Polling that never lets an older answer overwrite a newer one, free of React so node --test covers it.

/**
 * `tick` loads once and hands the answer to `apply` or the failure to `fail`. A tick while a load
 * is still in flight is skipped, so answers arrive in order; nothing is handed on after `stop`.
 */
export function poller<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  fail: (error: Error) => void,
): { tick: () => void; stop: () => void } {
  let stopped = false,
    busy = false;
  return {
    tick() {
      if (stopped || busy) return;
      busy = true;
      load()
        .finally(() => (busy = false))
        .then(
          (value) => {
            if (!stopped) apply(value);
          },
          (error) => {
            if (!stopped) fail(error);
          },
        );
    },
    stop() {
      stopped = true;
    },
  };
}
