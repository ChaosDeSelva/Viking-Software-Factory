import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { KnowledgeProposal } from "../api/client.js";
import { useState } from "react";
import type { KnowledgeEntry, SearchHit, SourceRef } from "../api/types.js";
import { EmptyState, InfoHint, Page, Stack, Toolbar } from "@factory/ui";
import {
  Button,
  Callout,
  Card,
  Empty,
  Field,
  inputClass,
  LoadState,
  ScreenHeader,
  Status,
  textareaClass,
  Timestamp,
} from "../components/ui.js";
import { APPROVALS_LOCKED } from "./RunsScreen.js";
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
  /** `null` until proposals have been loaded for the selected delivery. */
  const [proposals, setProposals] = useState<KnowledgeProposal[] | null>(null);
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

  const header = (
    <ScreenHeader
      screen="knowledge"
      title="Knowledge"
      term="Knowledge"
      description="Facts about this project that agents may rely on, each backed by a source. Add them by hand or accept them from a delivery."
    />
  );
  if (!projectId)
    return (
      <Page>
        {header}
        <EmptyState
          title="Create or select a project first."
          action={
            <Button onClick={() => dispatch({ type: "navigate", view: "projects" })}>
              Open Projects
            </Button>
          }
        />
      </Page>
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
  // An empty field is not 0: Number("") would be.
  const conf = confidence.trim() === "" ? NaN : Number(confidence);
  const locked = !api.hasApprovalSession();
  const addBlocked = !claim.trim()
    ? "Write the claim first."
    : sources.length === 0
      ? "Add at least one source."
      : !(conf >= 0 && conf <= 1)
        ? "Set a confidence between 0 and 1."
        : null;

  const proposalsCard = (
    <Card
      title="Delivery knowledge proposals"
      term="Knowledge proposal"
      description="Facts a delivery's evidence supports. Accepted ones become valid knowledge."
    >
      <Stack gap={4}>
        {locked ? (
          <Callout tone="info" title="Approvals are locked">
            <ApprovalUnlock
              id="knowledge-approval"
              onUnlocked={() => notify("Knowledge approvals unlocked")}
            />
          </Callout>
        ) : null}
        <Field label="Delivery" id="knowledge-delivery" term="Delivery">
          <select
            id="knowledge-delivery"
            className={inputClass}
            value={executionId}
            onChange={(e) => {
              setExecutionId(e.target.value);
              setProposals(null);
            }}
          >
            <option value="">Select a delivery</option>
            {(deliveries.state.status === "ready" ? (deliveries.state.data ?? []) : []).map((d) => (
              <option key={d.id} value={d.id}>
                Plan v{d.planVersion} — {new Date(d.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            {...(!busy && !executionId ? { disabledReason: "Choose a delivery first." } : {})}
            onClick={() =>
              void run(async () => {
                setProposals(await api.listProposals(executionId));
              })
            }
          >
            Load proposals
          </Button>
          <Button
            disabled={busy}
            {...(!busy && !executionId
              ? { disabledReason: "Choose a delivery first." }
              : locked
                ? { disabledReason: APPROVALS_LOCKED }
                : {})}
            onClick={() =>
              void run(async () => {
                setProposals(await api.proposeKnowledge(executionId));
              })
            }
          >
            Propose from delivery
          </Button>
        </div>
        {proposals?.length === 0 ? <Empty>No proposals for this delivery.</Empty> : null}
        {proposals && proposals.length > 0 ? (
          <ul aria-label="Proposals" className="flex flex-col divide-y divide-line text-sm">
            {proposals.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <p className="[overflow-wrap:anywhere]">{p.claim}</p>
                <p className="flex flex-wrap items-center gap-2 text-muted">
                  <Status value={p.status} domain="knowledge-proposal" />
                  <span>{p.sourceRefs.length} evidence references</span>
                </p>
                {p.status === "proposed" ? (
                  <div className="flex flex-wrap gap-2">
                    {(["accepted", "rejected"] as const).map((decision) => (
                      <Button
                        key={decision}
                        size="sm"
                        variant={decision === "accepted" ? "primary" : "secondary"}
                        disabled={busy}
                        {...(locked ? { disabledReason: APPROVALS_LOCKED } : {})}
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
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </Card>
  );

  const addCard = (
    <Card
      title="Add knowledge"
      term="Valid knowledge"
      description="A claim with at least one source: a URL or a cited passage from the project index."
    >
      <form
        aria-label="Add knowledge"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (addBlocked) return;
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
            className={textareaClass}
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
          />
        </Field>
        <Field
          label="Confidence (0 to 1)"
          id="k-confidence"
          info="How sure you are the claim holds: 1 is certain. Agents weigh low-confidence facts less."
        >
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
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            Sources (at least one) <InfoHint term="Provenance" />
          </legend>
          {sources.length === 0 ? (
            <Empty>No sources yet.</Empty>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {sources.map((s, i) => (
                <li key={i} className="flex min-w-0 items-center gap-2 font-mono">
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {sourceText(s, hits)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSources(sources.filter((_, j) => j !== i))}
                  >
                    Remove <span className="sr-only">source {i + 1}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <Field label="Source URL" id="k-url">
                <input
                  id="k-url"
                  type="url"
                  className={inputClass}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
            </div>
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
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <Field label="Cite from the project index" id="k-cite" term="Citable passage">
                <input
                  id="k-cite"
                  type="search"
                  className={inputClass}
                  value={citeQ}
                  onChange={(e) => setCiteQ(e.target.value)}
                />
              </Field>
            </div>
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
            <ul
              className="flex flex-col divide-y divide-line rounded-md border border-line text-xs"
              aria-label="Citable passages"
            >
              {hits.map((h) => (
                <li key={h.chunkId} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">
                    {h.path}#L{h.startLine}-L{h.endLine}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
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
        <div>
          <Button
            type="submit"
            disabled={busy}
            {...(!busy && addBlocked ? { disabledReason: addBlocked } : {})}
          >
            Add entry
          </Button>
        </div>
      </form>
    </Card>
  );

  return (
    <Page>
      {header}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <Card
          title="Valid knowledge"
          term="Valid knowledge"
          headingLevel={2}
          {...(list.state.status === "ready" ? { count: list.state.data.length } : {})}
        >
          <Stack gap={4}>
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied(filter.trim());
              }}
            >
              <Toolbar
                label="Filter knowledge"
                actions={
                  <Button type="submit" variant="secondary">
                    Search
                  </Button>
                }
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
              </Toolbar>
            </form>
            <LoadState state={list.state} what="knowledge" onRetry={list.reload}>
              {(entries) =>
                entries.length === 0 ? (
                  <Empty
                    body={
                      applied
                        ? "Try other words, or clear the filter."
                        : "Accept a delivery proposal, or add a claim with a source."
                    }
                  >
                    {applied
                      ? "No entries match."
                      : "No knowledge entries yet. Add one with a source."}
                  </Empty>
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {entries.map((e) => (
                      <li
                        key={e.id}
                        className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0"
                      >
                        <p className="text-sm font-medium [overflow-wrap:anywhere]">{e.claim}</p>
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          <Status value={e.validity} domain="knowledge" />
                          <span>
                            Confidence {e.confidence} · by {e.createdBy}
                          </span>
                          <span>
                            · <Timestamp value={e.createdAt} />
                          </span>
                        </p>
                        <ul
                          className="flex flex-col gap-0.5 text-xs text-muted"
                          aria-label="Sources"
                        >
                          {e.sources.map((s) => (
                            <li key={s.label} className="font-mono [overflow-wrap:anywhere]">
                              {s.label}
                            </li>
                          ))}
                        </ul>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              setAction({ id: e.id, kind: "supersede", text: e.claim })
                            }
                          >
                            Supersede <span className="sr-only">{e.claim}</span>
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setAction({ id: e.id, kind: "retract", text: "" })}
                          >
                            Retract <span className="sr-only">{e.claim}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void run(async () =>
                                setHistory({ id: e.id, entries: await api.knowledgeHistory(e.id) }),
                              )
                            }
                          >
                            History <span className="sr-only">{e.claim}</span>
                          </Button>
                          <InfoHint term="Supersede" label="About Supersede and Retract">
                            Supersede saves a corrected claim with the same sources; Retract marks
                            the claim as no longer true.
                          </InfoHint>
                        </div>
                        {action?.id === e.id ? (
                          <form
                            aria-label={
                              action.kind === "retract" ? "Retract entry" : "Supersede entry"
                            }
                            className="flex flex-col gap-3 rounded-md border border-line p-4"
                            onSubmit={(ev) => {
                              ev.preventDefault();
                              if (!action.text.trim()) return;
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
                                  action.kind === "retract"
                                    ? "Entry retracted"
                                    : "Entry superseded",
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
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="submit"
                                variant={action.kind === "retract" ? "danger" : "primary"}
                                disabled={busy}
                                {...(!busy && !action.text.trim()
                                  ? {
                                      disabledReason:
                                        action.kind === "retract"
                                          ? "Give a reason first."
                                          : "Write the corrected claim first.",
                                    }
                                  : {})}
                              >
                                {action.kind === "retract"
                                  ? "Confirm retraction"
                                  : "Save new version"}
                              </Button>
                              <Button variant="secondary" onClick={() => setAction(null)}>
                                Cancel
                              </Button>
                            </div>
                          </form>
                        ) : null}
                        {history?.id === e.id ? (
                          <ol
                            className="flex flex-col gap-1 rounded-md bg-sunken p-3 text-xs"
                            aria-label="History"
                          >
                            {history.entries.map((h, i) => (
                              <li key={h.id} className="flex flex-wrap items-center gap-2">
                                <span className="text-muted">{i + 1}.</span>
                                <span className="min-w-0 [overflow-wrap:anywhere]">{h.claim}</span>
                                <Status value={h.validity} domain="knowledge" />
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
          </Stack>
        </Card>
        <div className="flex min-w-0 flex-col gap-6">
          {addCard}
          {proposalsCard}
        </div>
      </div>
    </Page>
  );
}
