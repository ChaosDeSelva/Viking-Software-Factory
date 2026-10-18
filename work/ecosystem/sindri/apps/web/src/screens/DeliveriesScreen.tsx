import { useState } from "react";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { DeliveryReport, TraceNode, PrDelivery } from "../api/delivery-types.js";
import { traceTree } from "../api/trace-tree.js";
import { Badge, Button, Card, DetailHeading, Empty, LoadState } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

export function DeliveriesScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  const list = useLoad(projectId ? () => api.listDeliveries(projectId) : null, [projectId]);

  if (!projectId)
    return (
      <Card title="Deliveries">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Deliveries">
        <LoadState state={list.state} what="deliveries" onRetry={list.reload}>
          {(items) =>
            items.length === 0 ? (
              <Empty>No deliveries yet. A run becomes a delivery once it is verified.</Empty>
            ) : (
              <ul className="space-y-1">
                {items.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      aria-pressed={state.deliveryId === d.id}
                      onClick={() => dispatch({ type: "delivery/open", deliveryId: d.id })}
                      className="w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 dark:hover:bg-slate-800"
                    >
                      <span className="block font-mono text-xs">{d.id}</span>
                      <span className="text-xs">
                        Plan v{d.planVersion} <Badge tone="ok">{d.status}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadState>
      </Card>
      <div className="lg:col-span-2">
        {state.deliveryId ? (
          <DeliveryDetail key={state.deliveryId} deliveryId={state.deliveryId} />
        ) : (
          <Card title="Delivery">
            <Empty>Select a delivery to see its report, local result and trace.</Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const detail = useLoad(() => api.getDelivery(deliveryId), [deliveryId]);
  const trace = useLoad(() => api.deliveryTrace(deliveryId), [deliveryId]);
  const local = useLoad(() => api.localDelivery(deliveryId), [deliveryId]);
  const [busy, setBusy] = useState(false);
  const [exportRequest, setExportRequest] = useState<PrDelivery | null>(null);
  const [, setUnlockTick] = useState(0);
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });

  return (
    <div className="space-y-4">
      <LoadState state={detail.state} what="delivery" onRetry={detail.reload}>
        {(d) => (
          <>
            <Report report={d.report} />
            <Card title="Local delivery">
              <section aria-label="Delivery description">
                <pre
                  tabIndex={0}
                  className="max-h-80 overflow-auto rounded bg-slate-100 p-3 text-xs whitespace-pre-wrap dark:bg-slate-900"
                >
                  {d.prDescription}
                </pre>
              </section>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(d.prDescription)
                      .then(() => notify("Delivery summary copied to the clipboard"), report)
                  }
                >
                  Copy summary
                </Button>
                <Button
                  disabled={busy || !api.hasApprovalSession()}
                  aria-describedby="pr-hint"
                  onClick={() => {
                    setBusy(true);
                    api
                      .requestPr(deliveryId)
                      .then((pr) => {
                        setExportRequest(pr);
                        notify(
                          `Local delivery: ${pr.status === "built" ? "approve the export below" : "ready"}`,
                        );
                      }, report)
                      .finally(() => {
                        setBusy(false);
                        local.reload();
                        detail.reload();
                      });
                  }}
                >
                  Export local result
                </Button>
                <p id="pr-hint" className="text-xs text-slate-600 dark:text-slate-300">
                  Requires passing quality gates and delivery approval. Download the patch and apply
                  it in your project folder. GitHub is not required.
                </p>
              </div>
              <ApprovalUnlock
                id="pr-approval-code"
                onUnlocked={() => setUnlockTick((n) => n + 1)}
              />
              {exportRequest?.prs
                .filter((p) => p.status === "awaiting_approval" && p.approvalId)
                .map((p) => (
                  <Button
                    key={p.approvalId}
                    disabled={busy || !api.hasApprovalSession()}
                    onClick={() => {
                      setBusy(true);
                      api
                        .decideApproval(
                          deliveryId,
                          p.approvalId!,
                          "approved",
                          "Approve verified local export",
                        )
                        .then(() => api.requestPr(deliveryId))
                        .then(setExportRequest, report)
                        .finally(() => {
                          setBusy(false);
                          local.reload();
                          detail.reload();
                        });
                    }}
                  >
                    Approve local export: {p.planTaskId}
                  </Button>
                ))}
              <LoadState state={local.state} what="local result" onRetry={local.reload}>
                {(result) =>
                  result ? (
                    <div className="space-y-2 text-sm">
                      <p>
                        Project: <code>{result.repoPath}</code>
                      </p>
                      <p>
                        Verified result: <code>{result.resultCommit}</code>
                      </p>
                      <Button
                        onClick={() => {
                          const url = URL.createObjectURL(
                            new Blob([result.patch], { type: "text/plain" }),
                          );
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = "result.patch";
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }}
                      >
                        Download result.patch
                      </Button>
                      <p>From the project folder, using the downloaded patch path:</p>
                      <pre className="overflow-auto text-xs">{result.apply}</pre>
                      <p>To undo the same patch:</p>
                      <pre className="overflow-auto text-xs">{result.undo}</pre>
                    </div>
                  ) : (
                    <Empty>No approved local export yet.</Empty>
                  )
                }
              </LoadState>
            </Card>
          </>
        )}
      </LoadState>
      <Card title="Trace">
        <LoadState state={trace.state} what="trace" onRetry={trace.reload}>
          {(doc) => (
            <ul aria-label="Trace" className="text-sm">
              <TraceItem node={traceTree(doc)} />
            </ul>
          )}
        </LoadState>
      </Card>
    </div>
  );
}

function TraceItem({ node }: { node: TraceNode }) {
  const label = (
    <>
      <Badge>{node.kind}</Badge> {node.label}
    </>
  );
  return (
    <li className="ml-3 py-0.5">
      {label}
      {node.children.length ? (
        <ul className="border-l border-slate-300 pl-2 dark:border-slate-700">
          {node.children.map((c) => (
            <TraceItem key={`${c.kind}:${c.id}`} node={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Report({ report: r }: { report: DeliveryReport }) {
  return (
    <section
      aria-label="Delivery report"
      className="space-y-3 rounded-lg border border-slate-300 p-4 text-sm dark:border-slate-700"
    >
      <DetailHeading>{r.spec.title}</DetailHeading>
      <p>
        Spec v{r.spec.version} · plan v{r.plan.version} · mission{" "}
        <span className="font-mono">{r.missionId}</span> ·{" "}
        <Badge tone={r.status === "delivered_pending_merge" ? "ok" : "neutral"}>{r.status}</Badge>
      </p>
      <h3 className="font-medium">Requirements</h3>
      <table aria-label="Requirements" className="w-full text-left">
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Status</th>
            <th scope="col">Tasks</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {r.requirements.map((q) => (
            <tr key={q.criterionId}>
              <td>
                <span className="font-mono">{q.criterionId}</span> {q.text}
              </td>
              <td>
                <Badge tone={q.status === "satisfied" ? "ok" : "warn"}>{q.status}</Badge>
              </td>
              <td>
                {q.tasks
                  .map(
                    (t) =>
                      `${t.planTaskId} (gate ${t.gatePassed === null ? "not run" : t.gatePassed ? "passed" : "failed"})`,
                  )
                  .join(", ") || "none"}
              </td>
              <td className="font-mono text-xs">{q.evidence.join(", ") || "none"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="font-medium">Tasks and quality gates</h3>
      <ul className="ml-4 list-disc">
        {r.tasks.map((t) => (
          <li key={t.planTaskId}>
            <span className="font-mono">{t.planTaskId}</span> ({t.role}, {t.status}) ·{" "}
            {t.harness.id}@{t.harness.version} · Brokkr {t.brokkr ? t.brokkr.verdict : "no report"}{" "}
            · gate{" "}
            {t.gate
              ? t.gate.passed
                ? "passed"
                : `failed: ${t.gate.failures.map((f) => `${f.gateId} ${f.reason}`).join("; ")}`
              : "not evaluated"}
          </li>
        ))}
      </ul>
      <h3 className="font-medium">Summary</h3>
      {r.summary.sentences.length === 0 ? (
        <Empty>No evidence-backed summary.</Empty>
      ) : (
        <ul className="ml-4 list-disc">
          {r.summary.sentences.map((sn) => (
            <li key={sn.text}>{sn.text}</li>
          ))}
        </ul>
      )}
      {r.summary.stripped.length > 0 ? (
        <p className="text-xs">
          {r.summary.stripped.length} uncited sentence(s) were removed from the summary.
        </p>
      ) : null}
      <h3 className="font-medium">Tests</h3>
      {r.testResults.length === 0 ? (
        <Empty>No test runs recorded.</Empty>
      ) : (
        <ul className="ml-4 list-disc">
          {r.testResults.map((t) => (
            <li key={t.eventId}>
              <span className="font-mono">{t.command}</span> ({t.planTaskId ?? "unattributed"}):{" "}
              {t.passed ? "passed" : "failed"}
              {t.durationMs === null ? "" : ` in ${t.durationMs} ms`}
            </li>
          ))}
        </ul>
      )}
      <h3 className="font-medium">Changed files</h3>
      {r.changedFiles.length === 0 ? (
        <Empty>No changed-file manifest recorded.</Empty>
      ) : (
        <ul className="ml-4 list-disc font-mono text-xs">
          {r.changedFiles.map((c) => (
            <li key={`${c.planTaskId ?? ""}:${c.path}`}>
              {c.status ? `${c.status} ` : ""}
              {c.path}
            </li>
          ))}
        </ul>
      )}
      <h3 className="font-medium">Review findings</h3>
      {r.reviews.length === 0 ? (
        <Empty>No independent reviews recorded.</Empty>
      ) : (
        <ul className="ml-4 list-disc">
          {r.reviews.map((rv) => (
            <li key={rv.reviewId}>
              {rv.role} review of {rv.planTaskId}: {rv.verdict ?? "pending"}
              {rv.reason ? ` (${rv.reason})` : ""}
              {rv.findings.map((fd) => ` · [${fd.severity}] ${fd.message}`).join("")}
            </li>
          ))}
        </ul>
      )}
      <h3 className="font-medium">Limitations</h3>
      {r.limitations.length === 0 ? (
        <Empty>None recorded.</Empty>
      ) : (
        <ul className="ml-4 list-disc">
          {r.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <h3 className="font-medium">Rollback</h3>
      <ul className="ml-4 list-disc">
        {r.rollback.branches.map((b) => (
          <li key={b.branch}>
            branch <span className="font-mono">{b.branch}</span> from {b.baseSha.slice(0, 12)}
          </li>
        ))}
        <li>{r.rollback.note}</li>
      </ul>
    </section>
  );
}
