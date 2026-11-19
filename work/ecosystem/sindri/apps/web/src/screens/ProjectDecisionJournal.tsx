import { useState } from "react";
import type { JournalEntry, JournalProposal } from "../api/steward-types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import {
  Button,
  Card,
  Empty,
  Field,
  LoadState,
  inputClass,
  textareaClass,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const statuses = {
  proposed: "Awaiting approval",
  accepted: "In effect",
  rejected: "Rejected",
  superseded: "Replaced",
  deprecated: "Retired",
} as const;

type Editor = { kind: "new" } | { kind: "change" | "reverse"; entry: JournalEntry };

function ProposalForm({
  editor,
  onSubmit,
  onCancel,
  busy,
}: {
  editor: Editor;
  onSubmit: (value: JournalProposal) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const original = editor.kind === "new" ? undefined : editor.entry;
  const [title, setTitle] = useState(original?.title ?? "");
  const [decision, setDecision] = useState(editor.kind === "change" ? editor.entry.decision : "");
  const [rationale, setRationale] = useState("");
  const [source, setSource] = useState("");
  return (
    <form
      aria-label="Decision proposal"
      className="grid gap-3 rounded-md border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          title: title.trim(),
          decision: decision.trim(),
          rationale: rationale.trim(),
          source: source.trim(),
          ...(original && { supersedesId: original.id }),
        });
      }}
    >
      <h4 className="font-semibold">
        {editor.kind === "new"
          ? "New project decision"
          : editor.kind === "change"
            ? "Propose a change"
            : "Propose a reversal"}
      </h4>
      {original && (
        <p className="text-sm text-muted">
          “{original.title}” stays in effect until this proposal is accepted.
        </p>
      )}
      <Field label="Title" id="journal-title">
        <input
          id="journal-title"
          className={inputClass}
          value={title}
          required
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        label={
          editor.kind === "reverse"
            ? "What should apply after the reversal?"
            : "What should the project do?"
        }
        id="journal-choice"
      >
        <textarea
          id="journal-choice"
          className={textareaClass}
          value={decision}
          required
          maxLength={4000}
          onChange={(e) => setDecision(e.target.value)}
        />
      </Field>
      <Field label="Why make this choice?" id="journal-rationale">
        <textarea
          id="journal-rationale"
          className={textareaClass}
          value={rationale}
          required
          maxLength={4000}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
      <Field
        label="Source"
        id="journal-source"
        hint="Name the ticket, spec, discussion or other evidence for this choice."
      >
        <input
          id="journal-source"
          aria-describedby="journal-source-hint"
          className={inputClass}
          value={source}
          required
          maxLength={1000}
          onChange={(e) => setSource(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={busy || ![title, decision, rationale, source].every((value) => value.trim())}
        >
          Submit proposal
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ProjectDecisionJournal({ projectId }: { projectId: string }) {
  const api = useApi();
  const report = useReportError();
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === projectId)?.name ?? projectId;
  const journal = useLoad(() => api.getProjectJournal(projectId), [api, projectId]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [, unlock] = useState(0);
  const mutate = async (action: () => Promise<unknown>, notice: string) => {
    setBusy(true);
    try {
      await action();
      setEditor(null);
      journal.reload();
      dispatch({ type: "notice", notice: { kind: "info", text: notice } });
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const form = editor && (
    <ProposalForm
      key={editor.kind === "new" ? "new" : editor.kind + editor.entry.id}
      editor={editor}
      busy={busy}
      onCancel={() => setEditor(null)}
      onSubmit={(proposal) =>
        void mutate(
          () => api.proposeProjectDecision(projectId, proposal),
          "Project decision proposed for review",
        )
      }
    />
  );
  return (
    <Card
      title="Project decision journal"
      description={`Accepted choices guide future plans for ${project}. Each change includes the choices accepted by its first verification. Later approvals go in the next change.`}
    >
      <LoadState state={journal.state} what="project decision journal" onRetry={journal.reload}>
        {({ entries, markdown }) => {
          const byId = new Map(entries.map((entry) => [entry.id, entry]));
          const successors = new Map(
            entries
              .filter(
                (entry) =>
                  entry.supersedesId &&
                  (entry.status === "accepted" || entry.status === "superseded"),
              )
              .map((entry) => [entry.supersedesId, entry]),
          );
          return (
            <div className="grid gap-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={busy || editor !== null}
                  onClick={() => setEditor({ kind: "new" })}
                >
                  Propose a decision
                </Button>
                {entries.length > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const href = URL.createObjectURL(
                        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
                      );
                      const a = document.createElement("a");
                      a.href = href;
                      a.download = "DECISIONS.md";
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(href), 1000);
                    }}
                  >
                    Download journal
                  </Button>
                )}
              </div>
              {editor?.kind === "new" && form}
              {entries.some((e) => e.status === "proposed") && !api.hasApprovalSession() && (
                <ApprovalUnlock id="journal-approval" onUnlocked={() => unlock((n) => n + 1)} />
              )}
              {entries.length === 0 ? (
                <Empty>No project decisions yet.</Empty>
              ) : (
                <ol aria-label="Project decisions" className="grid gap-3">
                  {entries.toReversed().map((entry) => {
                    const prior = entry.supersedesId ? byId.get(entry.supersedesId) : undefined;
                    const stale =
                      entry.status === "proposed" &&
                      entry.supersedesId !== null &&
                      prior?.status !== "accepted";
                    const successor = successors.get(entry.id);
                    return (
                      <li
                        key={entry.id}
                        className="grid min-w-0 gap-2 rounded-md border border-line p-4 [overflow-wrap:anywhere]"
                      >
                        <p className="text-xs font-semibold">
                          {statuses[entry.status] ?? entry.status}
                        </p>
                        <h4 className="font-semibold">{entry.title}</h4>
                        <p className="whitespace-pre-wrap text-sm">{entry.decision}</p>
                        <p className="whitespace-pre-wrap text-sm">
                          <strong>Reason</strong> · {entry.rationale}
                        </p>
                        {entry.exportBlockedReason && (
                          <p className="text-sm text-muted">
                            <strong>Private journal only.</strong> {entry.exportBlockedReason}
                            {entry.status === "accepted" &&
                              " Propose a replacement with project-facing wording to include it in a patch. Put private evidence in Source."}
                          </p>
                        )}
                        <p className="text-sm">
                          <strong>Source</strong> · {entry.source}
                        </p>
                        <p className="text-xs text-muted">
                          Recorded by {entry.actor ?? "Unrecorded"} ·{" "}
                          {new Date(entry.createdAt).toLocaleString()}
                          {entry.decidedAt && (
                            <>
                              {" "}
                              · Reviewed by {entry.decidedBy ?? "Unrecorded"} ·{" "}
                              {new Date(entry.decidedAt).toLocaleString()}
                            </>
                          )}
                        </p>
                        {entry.supersedesId && (
                          <p className="text-sm">
                            {entry.status === "proposed"
                              ? "Would replace"
                              : entry.status === "rejected"
                                ? "Proposed replacing"
                                : "Replaces"}{" "}
                            · {prior?.title ?? entry.supersedesId}
                            {prior && <span> · {prior.decision}</span>}
                          </p>
                        )}
                        {successor && (
                          <p className="text-sm">
                            Replaced by · {successor.title} · {successor.decision}
                          </p>
                        )}
                        {entry.history.length > 0 && (
                          <details className="text-sm">
                            <summary className="cursor-pointer">Decision history</summary>
                            <ol
                              aria-label={`History for ${entry.title}`}
                              className="list-inside list-disc py-1"
                            >
                              {entry.history.map((event, index) => (
                                <li key={index}>
                                  {statuses[event.status] ?? event.status} · {event.actor} ·{" "}
                                  {new Date(event.at).toLocaleString()}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                        {stale && (
                          <p className="text-sm">
                            The decision this proposal would replace is no longer in effect. Reject
                            this proposal and propose a change to the current choice.
                          </p>
                        )}
                        {entry.status === "proposed" && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              disabled={
                                busy || editor !== null || stale || !api.hasApprovalSession()
                              }
                              onClick={() =>
                                void mutate(
                                  () => api.reviewProjectDecision(projectId, entry.id, "accepted"),
                                  "Project decision in effect",
                                )
                              }
                            >
                              Accept proposal
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={busy || editor !== null || !api.hasApprovalSession()}
                              onClick={() =>
                                void mutate(
                                  () => api.reviewProjectDecision(projectId, entry.id, "rejected"),
                                  "Project proposal rejected",
                                )
                              }
                            >
                              Reject proposal
                            </Button>
                          </div>
                        )}
                        {entry.status === "accepted" && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="secondary"
                              disabled={busy || editor !== null}
                              onClick={() => setEditor({ kind: "change", entry })}
                            >
                              Propose change
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={busy || editor !== null}
                              onClick={() => setEditor({ kind: "reverse", entry })}
                            >
                              Propose reversal
                            </Button>
                          </div>
                        )}
                        {editor && editor.kind !== "new" && editor.entry.id === entry.id && form}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          );
        }}
      </LoadState>
    </Card>
  );
}
