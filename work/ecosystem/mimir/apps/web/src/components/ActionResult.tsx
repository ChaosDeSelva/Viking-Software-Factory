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
        className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-fg"
      >
        {outcome.error.code ? (
          <code className="mr-1 font-mono text-xs font-semibold text-danger-fg">
            {outcome.error.code}
          </code>
        ) : null}
        {outcome.error.message}
      </p>
    );
  }
  return (
    <p
      role="status"
      className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-fg [overflow-wrap:anywhere]"
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
