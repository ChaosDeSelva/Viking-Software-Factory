import { useCallback, useState } from "react";
import { describeError } from "../api/client.js";
import { useStore } from "../store/StoreProvider.js";
import type { ActionOutcome } from "../components/ActionResult.js";

/** Wraps an SDK mutation: tracks busy state and turns the result into an `ActionOutcome`. */
export function useAction() {
  const { reportError } = useStore();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const run = useCallback(
    async <T>(fn: () => Promise<T>, message: (r: T) => string): Promise<T | null> => {
      setBusy(true);
      setOutcome(null);
      try {
        const r = await fn();
        const ids = r as { operationId?: unknown; commandId?: unknown };
        setOutcome({
          kind: "ok",
          message: message(r),
          ...(typeof ids?.operationId === "string" ? { operationId: ids.operationId } : {}),
          ...(typeof ids?.commandId === "string" ? { commandId: ids.commandId } : {}),
        });
        return r;
      } catch (e) {
        reportError(e);
        setOutcome({ kind: "error", error: describeError(e) });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reportError],
  );
  return { busy, outcome, run, setOutcome };
}
