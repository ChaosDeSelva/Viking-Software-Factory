// Accepted plans and research a new request can carry as context: every agent on the request is
// given them as background.
import { Checkbox, Timestamp } from "@factory/ui";
import { useState } from "react";
import { useHeimdall } from "../app/context";
import type { R } from "../lib/api";
import { scopeOf } from "./scope";
import { WorkKindBadge } from "./WorkForms";
import {
  contextFromQuery,
  decidedDocuments,
  MAX_CONTEXT_DOCUMENTS,
} from "./workKinds";

/** Chosen context runs, starting from a `?context=` link (Documents → Use as context). */
export function useContextDocs() {
  return useState<string[]>(() => contextFromQuery(location.search));
}

export function ContextPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { state } = useHeimdall();
  // Documents from every project: a plan made for one project often guides work in another.
  const docs = decidedDocuments(scopeOf(state, "all").deliveries);
  const full = value.length >= MAX_CONTEXT_DOCUMENTS;
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={`${id}-hint`}
    >
      <legend className="mb-1 text-sm font-medium text-fg">
        Context documents (optional)
      </legend>
      {docs.length === 0 ? (
        <p className="text-sm text-muted">
          No accepted plans or research yet. Accepted ones appear here and on
          the Documents page.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {docs.map((d: R) => {
            const runId = String(d.executionId ?? d.id);
            const checked = value.includes(runId);
            return (
              <li key={runId}>
                <Checkbox
                  id={`${id}-${runId}`}
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...value, runId]
                        : value.filter((x) => x !== runId),
                    )
                  }
                  label={
                    <span className="[overflow-wrap:anywhere]">
                      {String(d.work?.title ?? runId)}
                    </span>
                  }
                  description={
                    <span className="flex flex-wrap items-center gap-2">
                      <WorkKindBadge kind={d.work?.kind} />
                      {d.work?.decidedAt && (
                        <span>
                          accepted <Timestamp value={d.work.decidedAt} />
                        </span>
                      )}
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${id}-hint`} className="text-xs text-muted">
        Every agent on this request reads the chosen documents as background
        (at most {MAX_CONTEXT_DOCUMENTS}). The code still wins where they
        disagree.
      </p>
    </fieldset>
  );
}
