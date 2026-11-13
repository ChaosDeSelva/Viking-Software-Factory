import {
  Cluster,
  FindingsTable,
  KeyValue,
  ResearchDoc,
  Stack,
  Tabs,
  stripPrivateCitations,
  type Finding,
} from "@factory/ui";
import { useState } from "react";
import type { DeliveryDetail } from "../api/delivery-types.js";
import type { ResearchReport } from "../api/work-types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { GateFailureList } from "../components/ReasonCode.js";
import { WorkKindBadge } from "../components/WorkKind.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  DetailHeading,
  Empty,
  Field,
  Status,
  textareaClass,
  Timestamp,
} from "../components/ui.js";
import { useApi, useReportError, useStore } from "../store/context.js";
import { asDocSource, GuidanceUsedCard } from "./GuidanceUsed.js";
import { APPROVALS_LOCKED } from "./RunsScreen.js";

const noFileLink = () => undefined;

/** A research delivery: the document, its checks, and the accept / reject / follow-up decision. */
export function ResearchDelivery({
  deliveryId,
  detail,
  reload,
}: {
  deliveryId: string;
  detail: DeliveryDetail;
  reload: () => void;
}) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const r = detail.report;
  const research = r.research as ResearchReport;
  const [tab, setTab] = useState("document");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<"reject" | "follow-up" | null>(null);
  const [reason, setReason] = useState("");
  const [question, setQuestion] = useState("");
  const [, setUnlockTick] = useState(0);
  const locked = !api.hasApprovalSession();
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const sources = research.sources.map(asDocSource);
  const decision = research.decision;
  const checksFailed = research.gate?.passed === false || research.factCheck?.gatePassed === false;

  const act = (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    fn()
      .then(() => {
        notify(done);
        after?.();
        reload();
      }, report)
      .finally(() => setBusy(false));
  };

  const decideReason = decision
    ? `This document was already ${decision.decision}.`
    : locked
      ? APPROVALS_LOCKED
      : undefined;
  const acceptReason =
    decideReason ?? (checksFailed ? "The quality checks have not passed." : undefined);

  const findings: Finding[] = (research.factCheck?.findings ?? []).map((f, i) => ({
    id: f.id ?? `fc-${i}`,
    severity: f.severity,
    message: f.message,
    ...(f.category ? { category: f.category } : {}),
    ...(f.file ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  }));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Stack gap={3}>
        <Cluster gap={3} className="min-w-0">
          <DetailHeading>{research.question ?? r.spec.title}</DetailHeading>
          <WorkKindBadge kind="research" />
          {decision ? (
            <Badge tone={decision.decision === "accepted" ? "ok" : "danger"}>
              {decision.decision === "accepted"
                ? "Accepted"
                : decision.decision === "rejected"
                  ? "Rejected"
                  : String(decision.decision)}
            </Badge>
          ) : null}
          {research.containsPrivateSources ? (
            <Badge
              tone="warn"
              tooltip="It cites lessons from your feedback history. Copying removes those citations."
            >
              Contains private lessons
            </Badge>
          ) : null}
        </Cluster>
        <KeyValue
          items={[
            { label: "Spec", term: "Spec", value: `Version ${r.spec.version}` },
            { label: "Built", value: <Timestamp value={r.createdAt} /> },
            ...(decision
              ? [
                  {
                    label: "Decided",
                    value: (
                      <span className="[overflow-wrap:anywhere]">
                        {decision.actor}, <Timestamp value={decision.decidedAt} />
                        {decision.reason ? ` — ${decision.reason}` : ""}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
        <Cluster gap={2}>
          <Button
            disabled={busy}
            {...(acceptReason ? { disabledReason: acceptReason } : {})}
            onClick={() => act(() => api.acceptDocument(deliveryId), "Document accepted")}
          >
            Accept
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            {...(decideReason ? { disabledReason: decideReason } : {})}
            aria-expanded={open === "reject"}
            onClick={() => setOpen(open === "reject" ? null : "reject")}
          >
            Reject…
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            aria-expanded={open === "follow-up"}
            onClick={() => setOpen(open === "follow-up" ? null : "follow-up")}
          >
            Ask a follow-up…
          </Button>
        </Cluster>
        {locked && !decision ? (
          <Callout tone="info" title="Approvals are locked">
            <ApprovalUnlock id="doc-approval-code" onUnlocked={() => setUnlockTick((n) => n + 1)} />
          </Callout>
        ) : null}
        {open === "reject" ? (
          <form
            aria-label="Reject the document"
            className="flex flex-col gap-3 rounded-md border border-line p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason.trim() || decideReason) return;
              act(
                () => api.rejectDocument(deliveryId, reason.trim()),
                "Document rejected",
                () => {
                  setReason("");
                  setOpen(null);
                },
              );
            }}
          >
            <Field label="Why is it rejected?" id="doc-reject-reason">
              <textarea
                id="doc-reject-reason"
                rows={3}
                className={textareaClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div>
              <Button
                type="submit"
                variant="danger"
                disabled={busy}
                {...(decideReason
                  ? { disabledReason: decideReason }
                  : !reason.trim()
                    ? { disabledReason: "Give a reason first." }
                    : {})}
              >
                Reject document
              </Button>
            </div>
          </form>
        ) : null}
        {open === "follow-up" ? (
          <form
            aria-label="Ask a follow-up question"
            className="flex flex-col gap-3 rounded-md border border-line p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!question.trim()) return;
              act(
                () => api.followUp(deliveryId, question.trim()),
                "Follow-up question added to the inbox",
                () => {
                  setQuestion("");
                  setOpen(null);
                },
              );
            }}
          >
            <Field
              label="Follow-up question"
              id="doc-follow-up"
              hint="Becomes a new research item in the inbox, with this document as context."
            >
              <textarea
                id="doc-follow-up"
                rows={3}
                aria-describedby="doc-follow-up-hint"
                className={textareaClass}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </Field>
            <div>
              <Button
                type="submit"
                disabled={busy}
                {...(!question.trim() ? { disabledReason: "Ask a question first." } : {})}
              >
                Add follow-up
              </Button>
            </div>
          </form>
        ) : null}
      </Stack>
      <Tabs
        label="Research sections"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: "document",
            label: "Document",
            content: (
              <Card
                title="Document"
                actions={
                  research.document ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(stripPrivateCitations(research.document!.markdown, sources))
                          .then(
                            () =>
                              notify(
                                research.containsPrivateSources
                                  ? "Copied the document without private lessons"
                                  : "Copied the document",
                              ),
                            report,
                          )
                      }
                    >
                      Copy as Markdown
                    </Button>
                  ) : undefined
                }
              >
                {research.document ? (
                  <section aria-label="Research document">
                    <ResearchDoc
                      markdown={research.document.markdown}
                      sources={sources}
                      fileHref={noFileLink}
                    />
                  </section>
                ) : (
                  <Empty body="The research task did not record research.md.">
                    No research document was recorded.
                  </Empty>
                )}
              </Card>
            ),
          },
          {
            value: "checks",
            label: "Checks",
            ...(findings.length ? { count: findings.length } : {}),
            content: (
              <Stack gap={4}>
                <Card title="Document checks" term="Quality gate">
                  {research.gate ? (
                    <div className="flex flex-col gap-2 text-sm">
                      <Status
                        value={research.gate.passed ? "passed" : "failed"}
                        domain="gate"
                        tooltip={false}
                      />
                      {research.gate.passed ? null : (
                        <p className="text-muted [overflow-wrap:anywhere]">
                          <GateFailureList failures={research.gate.failures} />
                        </p>
                      )}
                    </div>
                  ) : (
                    <Empty>Not evaluated yet.</Empty>
                  )}
                </Card>
                <Card
                  title="Fact-check"
                  description="A second agent's spot-check of the document's claims against their sources."
                >
                  {research.factCheck ? (
                    <Stack gap={3}>
                      <Cluster gap={2}>
                        {research.factCheck.verdict ? (
                          <Status
                            value={research.factCheck.verdict}
                            domain="review-verdict"
                            tooltip={false}
                          />
                        ) : (
                          <Badge>No verdict</Badge>
                        )}
                      </Cluster>
                      <FindingsTable
                        findings={findings}
                        caption="Fact-check findings"
                        emptyText="No fact-check findings."
                      />
                    </Stack>
                  ) : (
                    <Empty>Fact-checking was off for this question.</Empty>
                  )}
                </Card>
              </Stack>
            ),
          },
          {
            value: "guidance",
            label: "Guidance",
            content: <GuidanceUsedCard guidance={r.guidance} />,
          },
        ]}
      />
    </div>
  );
}
