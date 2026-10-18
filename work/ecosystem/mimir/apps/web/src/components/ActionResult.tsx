import type { DescribedError } from "../api/client.js";

export type ActionOutcome =
  | { kind: "ok"; message: string; operationId?: string; commandId?: string }
  | { kind: "error"; error: DescribedError };

/** Shows the outcome of a mutation: the audit identifiers on success, the server code on failure. */
export function ActionResult({ outcome }: { outcome: ActionOutcome | null }) {
  if (!outcome) return null;
  if (outcome.kind === "error") {
    return (
      <p
        role="alert"
        className="mt-2 rounded border border-red-700 bg-red-50 p-2 text-red-900 dark:bg-red-950 dark:text-red-100"
      >
        {outcome.error.code ? <code className="mr-1">{outcome.error.code}</code> : null}
        {outcome.error.message}
      </p>
    );
  }
  return (
    <p
      role="status"
      className="mt-2 rounded border border-emerald-700 bg-emerald-50 p-2 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
    >
      {outcome.message}
      {outcome.operationId ? (
        <>
          {" "}
          (operation <code>{outcome.operationId}</code>
          {outcome.commandId ? (
            <>
              , command <code>{outcome.commandId}</code>
            </>
          ) : null}
          )
        </>
      ) : null}
    </p>
  );
}
