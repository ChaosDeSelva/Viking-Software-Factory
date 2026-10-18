import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { KnowledgeProposal } from "../api/client.js";
import { useState } from "react";
import type { KnowledgeEntry, SearchHit, SourceRef } from "../api/types.js";
import { Badge, Button, Card, Empty, Field, LoadState, inputClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const sourceText = (r: SourceRef, hits: SearchHit[]) => {
  if ("url" in r) return r.url;
  if ("taskEvidenceId" in r) return `evidence:${r.taskEvidenceId}`;
  const h = hits.find((x) => x.documentId === r.documentId);
  return `${h?.path ?? r.documentId}#L${r.startLine}-L${r.endLine}`;
};

export function KnowledgeScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const [executionId, setExecutionId] = useState("");
  const deliveries = useLoad(projectId ? () => api.listDeliveries(projectId) : null, [projectId]);
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const list = useLoad(
    projectId ? () => api.listKnowledge(projectId, applied || undefined) : null,
    [projectId, applied],
  );
  const [busy, setBusy] = useState(false);
  const [claim, setClaim] = useState("");
  const [confidence, setConfidence] = useState("0.8");
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [url, setUrl] = useState("");
  const [citeQ, setCiteQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [history, setHistory] = useState<{ id: string; entries: KnowledgeEntry[] } | null>(null);
  const [action, setAction] = useState<{
    id: string;
    kind: "retract" | "supersede";
    text: string;
  } | null>(null);

  if (!projectId)
    return (
      <Card title="Knowledge">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const conf = Number(confidence);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Delivery knowledge proposals">
        <ApprovalUnlock
          id="knowledge-approval"
          onUnlocked={() => notify("Knowledge approvals unlocked")}
        />
        <label htmlFor="knowledge-delivery">Delivery</label>
        <select
          id="knowledge-delivery"
          className={inputClass}
          value={executionId}
          onChange={(e) => {
            setExecutionId(e.target.value);
            setProposals([]);
          }}
        >
          <option value="">Select a delivery</option>
          {(deliveries.state.status === "ready" ? (deliveries.state.data ?? []) : []).map((d) => (
            <option key={d.id} value={d.id}>
              Plan v{d.planVersion} — {new Date(d.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
        <Button
          disabled={busy || !executionId}
          onClick={() =>
            void run(async () => {
              setProposals(await api.listProposals(executionId));
            })
          }
        >
          Load proposals
        </Button>
        <Button
          disabled={busy || !executionId || !api.hasApprovalSession()}
          onClick={() =>
            void run(async () => {
              setProposals(await api.proposeKnowledge(executionId));
            })
          }
        >
          Propose from delivery
        </Button>
        <ul>
          {proposals.map((p) => (
            <li key={p.id} className="my-3">
              <p>{p.claim}</p>
              <p>
                {p.status} · {p.sourceRefs.length} evidence references
              </p>
              {p.status === "proposed" &&
                (["accepted", "rejected"] as const).map((decision) => (
                  <Button
                    key={decision}
                    disabled={busy || !api.hasApprovalSession()}
                    onClick={() =>
                      void run(async () => {
                        await api.decideProposal(executionId, p.id, decision);
                        setProposals(await api.listProposals(executionId));
                        list.reload();
                      })
                    }
                  >
                    {decision === "accepted" ? "Accept" : "Reject"}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Valid knowledge">
        <form
          role="search"
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filter.trim());
          }}
        >
          <label htmlFor="knowledge-filter" className="sr-only">
            Search knowledge
          </label>
          <input
            id="knowledge-filter"
            type="search"
            className={inputClass}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter claims…"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <LoadState state={list.state} what="knowledge" onRetry={list.reload}>
          {(entries) =>
            entries.length === 0 ? (
              <Empty>
                {applied ? "No entries match." : "No knowledge entries yet. Add one with a source."}
              </Empty>
            ) : (
              <ul className="space-y-3">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="space-y-1 rounded border border-slate-200 p-2 dark:border-slate-700"
                  >
                    <p>{e.claim}</p>
                    <p className="text-xs">
                      Confidence {e.confidence} · by {e.createdBy}
                    </p>
                    <ul className="text-xs" aria-label="Sources">
                      {e.sources.map((s) => (
                        <li key={s.label} className="font-mono">
                          {s.label}
                        </li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setAction({ id: e.id, kind: "supersede", text: e.claim })}
                      >
                        Supersede <span className="sr-only">{e.claim}</span>
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setAction({ id: e.id, kind: "retract", text: "" })}
                      >
                        Retract <span className="sr-only">{e.claim}</span>
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void run(async () =>
                            setHistory({ id: e.id, entries: await api.knowledgeHistory(e.id) }),
                          )
                        }
                      >
                        History <span className="sr-only">{e.claim}</span>
                      </Button>
                    </div>
                    {action?.id === e.id ? (
                      <form
                        aria-label={action.kind === "retract" ? "Retract entry" : "Supersede entry"}
                        className="space-y-2"
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          void run(async () => {
                            if (action.kind === "retract")
                              await api.retractKnowledge(e.id, action.text.trim());
                            else
                              await api.supersedeKnowledge(e.id, {
                                claim: action.text.trim(),
                                sourceRefs: e.sourceRefs,
                                confidence: e.confidence,
                              });
                            setAction(null);
                            list.reload();
                            notify(
                              action.kind === "retract" ? "Entry retracted" : "Entry superseded",
                            );
                          });
                        }}
                      >
                        <Field
                          label={
                            action.kind === "retract"
                              ? "Reason for retraction"
                              : "Corrected claim (keeps the same sources)"
                          }
                          id={`action-${e.id}`}
                        >
                          <input
                            id={`action-${e.id}`}
                            className={inputClass}
                            value={action.text}
                            onChange={(ev) => setAction({ ...action, text: ev.target.value })}
                          />
                        </Field>
                        <div className="flex gap-2">
                          <Button
                            type="submit"
                            variant={action.kind === "retract" ? "danger" : "primary"}
                            disabled={busy || !action.text.trim()}
                          >
                            {action.kind === "retract" ? "Confirm retraction" : "Save new version"}
                          </Button>
                          <Button variant="secondary" onClick={() => setAction(null)}>
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : null}
                    {history?.id === e.id ? (
                      <ol className="list-decimal pl-5 text-xs" aria-label="History">
                        {history.entries.map((h) => (
                          <li key={h.id}>
                            {h.claim} <Badge>{h.validity}</Badge>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          }
        </LoadState>
      </Card>

      <Card title="Add knowledge">
        <form
          aria-label="Add knowledge"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.addKnowledge(projectId, {
                claim: claim.trim(),
                sourceRefs: sources,
                confidence: conf,
              });
              setClaim("");
              setSources([]);
              list.reload();
              notify("Knowledge entry added");
            });
          }}
        >
          <Field label="Claim" id="k-claim">
            <textarea
              id="k-claim"
              rows={2}
              className={inputClass}
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
            />
          </Field>
          <Field label="Confidence (0 to 1)" id="k-confidence">
            <input
              id="k-confidence"
              type="number"
              min={0}
              max={1}
              step={0.05}
              className={inputClass}
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sources (at least one)</legend>
            {sources.length === 0 ? (
              <Empty>No sources yet.</Empty>
            ) : (
              <ul className="text-xs">
                {sources.map((s, i) => (
                  <li key={i} className="flex items-center gap-2 font-mono">
                    {sourceText(s, hits)}
                    <Button
                      variant="secondary"
                      onClick={() => setSources(sources.filter((_, j) => j !== i))}
                    >
                      Remove <span className="sr-only">source {i + 1}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-end gap-2">
              <Field label="Source URL" id="k-url">
                <input
                  id="k-url"
                  type="url"
                  className={inputClass}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Button
                variant="secondary"
                disabled={!url.trim()}
                onClick={() => {
                  setSources([...sources, { url: url.trim() }]);
                  setUrl("");
                }}
              >
                Add URL
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <Field label="Cite from the project index" id="k-cite">
                <input
                  id="k-cite"
                  type="search"
                  className={inputClass}
                  value={citeQ}
                  onChange={(e) => setCiteQ(e.target.value)}
                />
              </Field>
              <Button
                variant="secondary"
                disabled={!citeQ.trim() || busy}
                onClick={() =>
                  void run(async () => setHits(await api.search(projectId, citeQ.trim())))
                }
              >
                Find
              </Button>
            </div>
            {hits.length > 0 ? (
              <ul className="space-y-1 text-xs" aria-label="Citable passages">
                {hits.map((h) => (
                  <li key={h.chunkId} className="flex items-center gap-2">
                    <span className="flex-1 font-mono">
                      {h.path}#L{h.startLine}-L{h.endLine}
                    </span>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setSources([
                          ...sources,
                          { documentId: h.documentId, startLine: h.startLine, endLine: h.endLine },
                        ])
                      }
                    >
                      Cite{" "}
                      <span className="sr-only">
                        {h.path} lines {h.startLine} to {h.endLine}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </fieldset>
          <Button
            type="submit"
            disabled={busy || !claim.trim() || sources.length === 0 || !(conf >= 0 && conf <= 1)}
          >
            Add entry
          </Button>
        </form>
      </Card>
    </div>
  );
}
