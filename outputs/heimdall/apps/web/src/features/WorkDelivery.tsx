// Inspector views for research and PR review deliveries. A research document is decided here
// (accept, reject, follow-up) through the command dialog; a PR review is read here and edited and
// posted in Sindri, which holds the posting approval.
import { DrawerActions } from "../app/DrawerActions";
import {
  Badge,
  Button,
  Callout,
  Cluster,
  Disclosure,
  Field,
  FindingsTable,
  KeyValue,
  ResearchDoc,
  Stack,
  Tabs,
  Textarea,
  Timestamp,
  cn,
  focusRing,
  stripPrivateCitations,
} from "@factory/ui";
import { useState, type ReactNode } from "react";
import { useHeimdall } from "../app/context";
import { Reasons, Status } from "../components/app";
import type { R } from "../lib/api";
import { sindriDeliveryHref } from "../lib/apps";
import { hrefFor, navigate } from "../lib/router";
import { useDetail, WorkKindBadge } from "./WorkForms";
import { renderDiagrams } from "../components/Mermaid";
import { scopeOf } from "./scope";
import { FactCheckList } from "./FactCheckList";
import {
  docSources,
  documentDecision,
  findingCounts,
  leakCheckOf,
  postedUrl,
  researchChecksPassed,
  reviewDraft,
  tableFindings,
  verdictLabel,
} from "./workKinds";
import { actionBlock } from "./workflowState";

function Block({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-md font-semibold">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

const digest = (d: unknown) =>
  String(d ?? "")
    .replace(/^sha256:/, "")
    .slice(0, 12);

const external = cn(
  "text-accent-fg hover:underline [overflow-wrap:anywhere]",
  focusRing,
);

/** Skills and notes the agents were given, by name and digest. */
export function GuidanceUsed({ guidance }: { guidance: R | undefined }) {
  if (!guidance)
    return (
      <Block title="Guidance used">
        <p className="text-sm text-muted">
          No operator guidance was recorded for this run.
        </p>
      </Block>
    );
  const skills: R[] = Array.isArray(guidance.skills) ? guidance.skills : [];
  const notes: [string, unknown, unknown][] = [
    ["Project notes", guidance.projectNotes, guidance.projectNotesDigest],
    ["Request notes", guidance.requestNotes, guidance.requestNotesDigest],
  ];
  return (
    <Block title="Guidance used">
      <h4 className="text-sm font-semibold">Skills</h4>
      {skills.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {skills.map((s) => (
            <li
              key={s.id ?? s.name}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="font-medium">{s.name}</span>
              <code className="text-xs text-muted">{digest(s.digest)}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">None.</p>
      )}
      {Array.isArray(guidance.omitted) && guidance.omitted.length > 0 && (
        <p className="text-sm text-muted">
          Left out (over the size cap):{" "}
          {guidance.omitted.map((s: R) => s.name).join(", ")}
        </p>
      )}
      <h4 className="text-sm font-semibold">Notes</h4>
      <ul className="flex flex-col gap-2 text-sm">
        {notes.map(([label, text, d]) => (
          <li key={label} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              {label}
              {d ? (
                <code className="text-xs text-muted">{digest(d)}</code>
              ) : (
                <Badge>None</Badge>
              )}
            </span>
            {d && typeof text === "string" && text ? (
              <Disclosure title={`Show ${label.toLowerCase()}`}>
                <pre className="font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {text}
                </pre>
              </Disclosure>
            ) : null}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Failures({ failures }: { failures: unknown }) {
  const rows: R[] = Array.isArray(failures) ? failures : [];
  if (!rows.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map((f, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          <code className="text-xs">{f.gateId ?? "gate"}</code>{" "}
          {f.reason ?? JSON.stringify(f)}
        </li>
      ))}
    </ul>
  );
}

export function ResearchView({
  executionId,
  report,
}: {
  executionId: string;
  report: R;
}) {
  const { session, propose, notify } = useHeimdall();
  const research: R = report.research ?? {};
  const [question, setQuestion] = useState("");
  const sources = docSources(research.sources);
  const decision: R | null = research.decision ?? null;
  const markdown: string | null = research.document?.markdown ?? null;
  const checksFailed = !researchChecksPassed(research);
  // Only the fact-check asked for changes: re-running the checks re-reads the same verdict.
  const changesOnly =
    checksFailed &&
    research.factCheck?.verdict === "request_changes" &&
    researchChecksPassed({ ...research, factCheck: null });
  const access = actionBlock("research.accept", undefined, session);
  const decided = decision
    ? `This document was already ${decision.decision}.`
    : "";
  const rejectWhy = access || decided;
  const acceptWhy =
    rejectWhy ||
    (changesOnly
      ? "The fact-check asked for changes. Ask a follow-up (its fact-check runs again), or reject it."
      : checksFailed
        ? "The quality checks have not passed."
        : "");
  const followWhy =
    actionBlock("research.followUp", undefined, session) ||
    (question.trim() ? "" : "Ask a question first.");
  const factFindings = tableFindings(research.factCheck?.findings, "fc");
  return (
    <Stack gap={6}>
      <Block title="Document">
        <Cluster gap={2}>
          <WorkKindBadge kind="research" />
          {decision ? (
            <Badge
              tone={decision.decision === "accepted" ? "forest" : "danger"}
            >
              {decision.decision === "accepted"
                ? "Accepted"
                : decision.decision === "rejected"
                  ? "Rejected"
                  : String(decision.decision)}
            </Badge>
          ) : (
            <Badge tone="warning">Awaiting your decision</Badge>
          )}
          {research.containsPrivateSources && (
            <Badge tone="forest">Contains private lessons</Badge>
          )}
        </Cluster>
        {research.question && <Question text={String(research.question)} />}
        {decision && (
          <KeyValue
            items={[
              {
                label: "Decided",
                value: (
                  <span className="[overflow-wrap:anywhere]">
                    {decision.actor}
                    {decision.decidedAt ? (
                      <>
                        , <Timestamp value={decision.decidedAt} />
                      </>
                    ) : null}
                    {decision.reason ? ` · ${decision.reason}` : ""}
                  </span>
                ),
              },
            ]}
          />
        )}
        <DrawerActions>
          {decision ? (
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {decision.decision === "accepted" && (
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() =>
                    navigate(
                      hrefFor("new-work", {
                        project: report.projectId,
                        context: executionId,
                      }),
                    )
                  }
                >
                  Start new work with this as context
                </Button>
              )}
              <p className="text-sm text-muted">
                {decided} Find it again on the Documents page.
              </p>
            </div>
          ) : (
            <>
              {checksFailed && !changesOnly && (
                // Without this a failed check is a dead end: Accept stays disabled until the checks
                // run again (for example after a fix to how they read the files).
                <Button
                  variant="secondary"
                  disabledReason={
                    actionBlock("execution.assess", undefined, session) ||
                    undefined
                  }
                  onClick={() => propose("execution.assess", executionId, {})}
                >
                  Re-run quality checks
                </Button>
              )}
              <div className="flex w-full gap-2 [&>*]:flex-1">
                <Button
                  variant="primary"
                  disabledReason={acceptWhy || undefined}
                  onClick={() =>
                    propose("research.accept", executionId, { reason: "" })
                  }
                >
                  Accept document
                </Button>
                <Button
                  variant="danger"
                  disabledReason={rejectWhy || undefined}
                  onClick={() =>
                    propose("research.reject", executionId, { reason: "" })
                  }
                >
                  Reject document
                </Button>
              </div>
              <p className="text-xs text-muted">
                The reason you give when you confirm is sent to Sindri with your
                decision. A rejection needs one.
              </p>
              <Reasons reasons={[acceptWhy, rejectWhy]} />
            </>
          )}
        </DrawerActions>
        <Disclosure title="Ask a follow-up question">
          <Stack gap={3}>
            <Field
              label="Follow-up question"
              hint="Becomes a new research intake, with this document as context."
            >
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </Field>
            <div>
              <Button
                variant="secondary"
                disabledReason={followWhy || undefined}
                onClick={() =>
                  propose(
                    "research.followUp",
                    executionId,
                    { question: question.trim() },
                    {},
                    {
                      onSuccess: () => setQuestion(""),
                    },
                  )
                }
              >
                Review follow-up
              </Button>
            </div>
            <Reasons reasons={[followWhy]} />
          </Stack>
        </Disclosure>
      </Block>
      <Block
        title="Research document"
        actions={
          markdown ? (
            <Button
              size="sm"
              variant="secondary"
              icon="copy"
              onClick={() =>
                void navigator.clipboard
                  .writeText(stripPrivateCitations(markdown, sources))
                  .then(
                    () =>
                      notify(
                        research.containsPrivateSources
                          ? "Copied the document without private lessons."
                          : "Copied the document.",
                        "success",
                      ),
                    () =>
                      notify("The clipboard is not available here.", "warning"),
                  )
              }
            >
              Copy as Markdown
            </Button>
          ) : undefined
        }
      >
        {markdown ? (
          <div className="rounded-md border border-line p-4">
            <ResearchDoc markdown={markdown} sources={sources} />
          </div>
        ) : (
          <Callout tone="warning">
            No research document was recorded for this run.
          </Callout>
        )}
      </Block>
      <Block title="Checks">
        <KeyValue
          items={[
            {
              label: "Document gates",
              value: research.gate ? (
                <Status
                  value={research.gate.passed ? "passed" : "failed"}
                  domain="gate"
                />
              ) : (
                "Not reported"
              ),
            },
            {
              label: "Fact-check",
              value: research.factCheck ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {research.factCheck.verdict === "request_changes" &&
                    findingCounts(research.factCheck.findings)
                      ? findingCounts(research.factCheck.findings)
                      : verdictLabel(research.factCheck.verdict)}
                  </span>
                  {typeof research.factCheck.gatePassed === "boolean" && (
                    <Status
                      value={factCheckResult(research.factCheck)}
                      domain="gate"
                    />
                  )}
                </span>
              ) : (
                "Off for this question"
              ),
            },
          ]}
        />
        <Failures failures={research.gate?.failures} />
        {research.factCheck && (
          <FactCheckList
            findings={factFindings}
            caption="Fact-check findings"
            emptyText="The fact-check found nothing to correct."
          />
        )}
      </Block>
      <GuidanceUsed guidance={report.guidance} />
    </Stack>
  );
}

/** Whether a plan's own checks passed: every project's findings, the writer's documents, the check. */
export function planChecksPassed(plan: R): boolean {
  const findings: R[] = Array.isArray(plan.findings) ? plan.findings : [];
  return (
    plan.gate?.passed === true &&
    findings.every((f) => f.gate?.passed === true) &&
    (plan.factCheck == null || plan.factCheck.gatePassed !== false)
  );
}

const download = (name: string, markdown: string) => {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown" }),
  );
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * A plan from text: the readable proposal and its engineering appendix (diagrams drawn), each
 * project's findings, the checks, and the decision (accept, reject or revise).
 */
export function ProposalView({
  executionId,
  report,
}: {
  executionId: string;
  report: R;
}) {
  const { session, propose, notify, state, open } = useHeimdall();
  // A later revision someone decided on replaces this version: nothing waits on it.
  const replacedBy = documentDecision(
    scopeOf(state, "all").deliveries,
    executionId,
  )?.replacedBy;
  const plan: R = report.proposal ?? {};
  const [feedback, setFeedback] = useState("");
  const sources = docSources(plan.sources);
  const decision: R | null = plan.decision ?? null;
  const proposal: string | null = plan.proposal?.markdown ?? null;
  const engineering: string | null = plan.engineering?.markdown ?? null;
  const findings: R[] = Array.isArray(plan.findings) ? plan.findings : [];
  const checksFailed = !planChecksPassed(plan);
  // Only the fact-check asked for changes: re-running the checks re-reads the same verdict.
  const changesOnly =
    checksFailed &&
    plan.factCheck?.verdict === "request_changes" &&
    planChecksPassed({ ...plan, factCheck: null });
  const access = actionBlock("research.accept", undefined, session);
  const decided = decision
    ? `This plan was already ${decision.decision}.`
    : replacedBy
      ? "A later revision of this plan was decided, so this version no longer needs a decision."
      : "";
  const rejectWhy = access || decided;
  // Only the fact-check's opinion failed: the operator may accept over it, with a reason.
  const acceptWhy =
    rejectWhy ||
    (checksFailed && !changesOnly ? "The quality checks have not passed." : "");
  const reviseWhy =
    actionBlock("research.followUp", undefined, session) ||
    (feedback.trim() ? "" : "Say what to change first.");
  const factFindings = tableFindings(plan.factCheck?.findings, "fc");
  const copy = (markdown: string, what: string) =>
    void navigator.clipboard.writeText(markdown).then(
      () => notify(`Copied the ${what}.`, "success"),
      () => notify("The clipboard is not available here.", "warning"),
    );
  const doc = (
    markdown: string | null,
    name: string,
    what: string,
    empty: string,
  ) =>
    markdown ? (
      <Stack gap={3}>
        <Cluster gap={2}>
          <Button
            size="sm"
            variant="secondary"
            icon="copy"
            onClick={() => copy(markdown, what)}
          >
            Copy as Markdown
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => download(name, markdown)}
          >
            Download {name}
          </Button>
        </Cluster>
        <div className="rounded-md border border-line p-4">
          <ResearchDoc
            markdown={markdown}
            sources={sources}
            renderCode={renderDiagrams}
          />
        </div>
      </Stack>
    ) : (
      <Callout tone="warning">{empty}</Callout>
    );
  const projectName = (f: R) =>
    f.project ? String(f.project) : "This project";
  return (
    <Stack gap={6}>
      <Block title="Plan">
        <Cluster gap={2}>
          {decision ? (
            <Badge
              tone={decision.decision === "accepted" ? "forest" : "danger"}
            >
              {decision.decision === "accepted"
                ? decision.overrodeFactCheck
                  ? "Accepted over the fact-check"
                  : "Accepted"
                : "Rejected"}
            </Badge>
          ) : (
            <Badge tone={replacedBy ? "neutral" : "warning"}>
              {replacedBy ? "Replaced by a revision" : "Awaiting your decision"}
            </Badge>
          )}
          <Badge tone="neutral">
            {findings.length} {findings.length === 1 ? "project" : "projects"}{" "}
            researched
          </Badge>
        </Cluster>
        {decision && (
          <KeyValue
            items={[
              {
                label: "Decided",
                value: (
                  <span className="[overflow-wrap:anywhere]">
                    {decision.actor}
                    {decision.decidedAt ? (
                      <>
                        , <Timestamp value={decision.decidedAt} />
                      </>
                    ) : null}
                    {decision.reason ? ` · ${decision.reason}` : ""}
                  </span>
                ),
              },
            ]}
          />
        )}
        <DrawerActions>
          {replacedBy && !decision ? (
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Button
                variant="primary"
                className="w-full"
                onClick={() =>
                  open("deliveries", {
                    id: replacedBy,
                    executionId: replacedBy,
                    title: "Plan",
                  })
                }
              >
                Open the revision that replaced it
              </Button>
              <p className="text-sm text-muted">{decided}</p>
            </div>
          ) : decision ? (
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {decision.decision === "accepted" && (
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() =>
                    navigate(
                      hrefFor("new-work", {
                        project: report.projectId,
                        context: executionId,
                      }),
                    )
                  }
                >
                  Start new work with this as context
                </Button>
              )}
              <p className="text-sm text-muted">
                {decided} Find it again on the Documents page.
              </p>
            </div>
          ) : (
            <>
              {checksFailed && !changesOnly && (
                <Button
                  variant="secondary"
                  disabledReason={
                    actionBlock("execution.assess", undefined, session) ||
                    undefined
                  }
                  onClick={() => propose("execution.assess", executionId, {})}
                >
                  Re-run quality checks
                </Button>
              )}
              <div className="flex w-full gap-2 [&>*]:flex-1">
                <Button
                  variant="primary"
                  disabledReason={acceptWhy || undefined}
                  onClick={() =>
                    propose("research.accept", executionId, {
                      reason: "",
                      document: "plan",
                      ...(changesOnly ? { override: true } : {}),
                    })
                  }
                >
                  {changesOnly ? "Accept over the fact-check" : "Accept plan"}
                </Button>
                <Button
                  variant="danger"
                  disabledReason={rejectWhy || undefined}
                  onClick={() =>
                    propose("research.reject", executionId, {
                      reason: "",
                      document: "plan",
                    })
                  }
                >
                  Reject plan
                </Button>
              </div>
              <Reasons reasons={[acceptWhy, rejectWhy]} />
              {changesOnly && !acceptWhy && (
                <p className="text-sm text-muted">
                  The fact-check asked for changes. Revise the plan above (its
                  fact-check runs again), or accept it as it is: your reason is
                  recorded with the decision.
                </p>
              )}
            </>
          )}
        </DrawerActions>
        {changesOnly && !decision && !replacedBy && (
          <Callout tone="warning" title="The fact-check asked for changes">
            {findingCounts(plan.factCheck?.findings) || "See its findings"}.
            Read them in the Fact-check tab below. Revise the plan here (the
            writer gets every finding, and the fact-check runs again), or accept
            it over the fact-check with your reason.
          </Callout>
        )}
        <Disclosure
          title="Revise the plan"
          defaultOpen={changesOnly && !decision && !replacedBy}
        >
          <Stack gap={3}>
            <Field
              label="What to change"
              hint="Starts a new plan over the same projects. Its writer gets this plan, its appendix and the fact-check to revise."
            >
              <Textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </Field>
            {changesOnly && !feedback.trim() && (
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setFeedback(
                      `Fix every finding the fact-check raised (${findingCounts(plan.factCheck?.findings)}). Where a finding is a judgement call, say what you decided and why.`,
                    )
                  }
                >
                  Fill in: fix the fact-check's findings
                </Button>
              </div>
            )}
            <div>
              <Button
                variant="secondary"
                disabledReason={reviseWhy || undefined}
                onClick={() =>
                  propose(
                    "research.followUp",
                    executionId,
                    { question: feedback.trim(), document: "plan" },
                    {},
                    { onSuccess: () => setFeedback("") },
                  )
                }
              >
                Revise
              </Button>
            </div>
            <Reasons reasons={[reviseWhy]} />
          </Stack>
        </Disclosure>
      </Block>
      <Tabs
        label="Plan documents"
        items={[
          {
            value: "proposal",
            label: "Proposal",
            content: doc(
              proposal,
              "proposal.md",
              "proposal",
              "No proposal was recorded for this run.",
            ),
          },
          {
            value: "engineering",
            label: "Engineering appendix",
            content: doc(
              engineering,
              "engineering.md",
              "engineering appendix",
              "No engineering appendix was recorded for this run.",
            ),
          },
          ...(plan.factCheck
            ? [
                {
                  value: "fact-check",
                  label: "Fact-check",
                  count: factFindings.length,
                  content: (
                    <FactCheckList
                      findings={factFindings}
                      caption="Fact-check findings"
                      emptyText="The fact-check found nothing to correct."
                    />
                  ),
                },
              ]
            : []),
          {
            value: "findings",
            label: "Findings",
            count: findings.length,
            content: (
              <Stack gap={3}>
                {findings.map((f) => (
                  <Disclosure key={String(f.planTaskId)} title={projectName(f)}>
                    <Stack gap={2}>
                      {f.gate && (
                        <Status
                          value={f.gate.passed ? "passed" : "failed"}
                          domain="gate"
                        />
                      )}
                      <Failures failures={f.gate?.failures} />
                      {f.document?.markdown ? (
                        <ResearchDoc
                          markdown={String(f.document.markdown)}
                          sources={[]}
                          renderCode={renderDiagrams}
                        />
                      ) : (
                        <p className="text-sm text-muted">
                          No findings were recorded.
                        </p>
                      )}
                    </Stack>
                  </Disclosure>
                ))}
              </Stack>
            ),
          },
        ]}
      />
      <Block title="Checks">
        <KeyValue
          items={[
            {
              label: "Documents",
              value: plan.gate ? (
                <Status
                  value={plan.gate.passed ? "passed" : "failed"}
                  domain="gate"
                />
              ) : (
                "Not reported"
              ),
            },
            {
              label: "Fact-check",
              value: plan.factCheck ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {plan.factCheck.verdict === "request_changes" &&
                    findingCounts(plan.factCheck.findings)
                      ? findingCounts(plan.factCheck.findings)
                      : verdictLabel(plan.factCheck.verdict)}
                  </span>
                  {typeof plan.factCheck.gatePassed === "boolean" && (
                    <Status
                      value={factCheckResult(plan.factCheck)}
                      domain="gate"
                    />
                  )}
                </span>
              ) : (
                "Off for this plan"
              ),
            },
          ]}
        />
        <Failures failures={plan.gate?.failures} />
        {plan.factCheck && (
          <p className="text-sm text-muted">
            The fact-check&apos;s findings are in the Fact-check tab above.
          </p>
        )}
      </Block>
      <GuidanceUsed guidance={report.guidance} />
    </Stack>
  );
}

/** A PR review delivery, read-only: the draft to be posted, its leak check, and a link to Sindri. */
export function PrReviewView({
  executionId,
  projectId,
  report,
}: {
  executionId: string;
  projectId: string | undefined;
  report: R;
}) {
  const { state } = useHeimdall();
  const review: R = report.review ?? {};
  // Read again when the report the inspector re-reads shows a different draft or post.
  const detail = useDetail<R>(
    "details/review-preview/" + executionId,
    (r) => r,
    JSON.stringify([review.draft?.version ?? null, review.posted ?? null]),
  );
  const preview = detail.status === "ready" ? detail.data : null;
  const previewError = detail.status === "error" ? detail.error : "";
  const draft = reviewDraft(review);
  const included = draft.findings.filter((f) => f.included !== false);
  const excluded = draft.findings.filter((f) => f.included === false);
  const posted = postedUrl(review, preview);
  const leak = preview ? leakCheckOf(preview) : null;
  const pr: R = review.pr ?? {};
  const prUrl =
    typeof pr.url === "string" && /^https:\/\/github\.com\//.test(pr.url)
      ? pr.url
      : null;
  const prName =
    pr.owner && pr.repo
      ? `${pr.owner}/${pr.repo}#${pr.number}`
      : "Pull request";
  const blockers: string[] = Array.isArray(preview?.blockers)
    ? preview.blockers
    : [];
  return (
    <Stack gap={6}>
      <Block title="Pull request">
        <Cluster gap={2}>
          <WorkKindBadge kind="pr_review" />
          {posted !== null ? (
            <Badge tone="forest">Posted</Badge>
          ) : (
            <Badge tone="warning">Not posted</Badge>
          )}
        </Cluster>
        <p className="text-sm [overflow-wrap:anywhere]">
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={external}
            >
              {prName}
              {pr.title ? ` · ${pr.title}` : ""}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <>
              {prName}
              {pr.title ? ` · ${pr.title}` : ""}
            </>
          )}
        </p>
        <KeyValue
          items={[
            { label: "Verdict", value: verdictLabel(draft.verdict) },
            ...(review.draft &&
            review.verdict &&
            review.verdict !== draft.verdict
              ? [
                  {
                    label: "Agent's verdict",
                    value: verdictLabel(review.verdict),
                  },
                ]
              : []),
            {
              label: "Findings",
              value: `${included.length} included · ${excluded.length} excluded`,
            },
          ]}
        />
        {posted !== null ? (
          <Callout tone="success" title="Posted to GitHub">
            {posted ? (
              <a
                href={posted}
                target="_blank"
                rel="noreferrer noopener"
                className={external}
              >
                Open the posted review
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              "Sindri reports the review as posted."
            )}
          </Callout>
        ) : null}
        <div>
          <a
            href={sindriDeliveryHref(projectId, executionId, state?.appOrigins)}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              "inline-flex h-control-md items-center justify-center gap-2 rounded-md border border-accent bg-accent px-4 text-sm font-semibold text-on-accent hover:border-accent-hover hover:bg-accent-hover",
              focusRing,
            )}
          >
            {posted !== null ? "Open in Sindri" : "Edit and post in Sindri"}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
        <p className="text-xs text-muted">
          Heimdall shows the review read-only. Including, rewording and posting
          happen in Sindri, which asks for the posting approval.
        </p>
      </Block>
      <Block title="Leak check">
        {previewError ? (
          <Callout tone="warning">
            The review preview could not be read: {previewError}
          </Callout>
        ) : !preview ? (
          <p role="status" className="text-sm text-muted">
            Reading the review preview…
          </p>
        ) : leak === null ? (
          <p className="text-sm text-muted">
            Sindri did not report a leak check.
          </p>
        ) : leak.ok ? (
          <Callout tone="success">
            Nothing private or secret found in the text to be posted.
          </Callout>
        ) : (
          <Callout tone="danger" title="Posting is blocked">
            Rule <code>{leak.rule}</code>
            {leak.findingId ? (
              <>
                {" "}
                in finding <code>{leak.findingId}</code>
              </>
            ) : null}
            . Reword or exclude it in Sindri.
          </Callout>
        )}
        {blockers.length > 0 && (
          <p className="text-sm text-muted">
            Sindri will not post yet: {blockers.join(", ").replace(/_/g, " ")}.
          </p>
        )}
      </Block>
      <Block title="Summary">
        {draft.summary ? (
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {draft.summary}
          </p>
        ) : (
          <p className="text-sm text-muted">No summary.</p>
        )}
      </Block>
      <Block title="Findings">
        <h4 className="text-sm font-semibold">
          Included in the review ({included.length})
        </h4>
        <FindingsTable
          findings={included}
          caption="Included findings"
          emptyText="No findings are included in the review."
        />
        {excluded.length > 0 && (
          <>
            <h4 className="text-sm font-semibold">
              Excluded ({excluded.length})
            </h4>
            <FindingsTable findings={excluded} caption="Excluded findings" />
          </>
        )}
        <Failures failures={review.gateFailures} />
      </Block>
      <GuidanceUsed guidance={report.guidance} />
    </Stack>
  );
}

/** The request a document answers: a pasted transcript is long, so it opens folded. */
function Question({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 400;
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">
        {long && !open ? `${text.slice(0, 400).trimEnd()}…` : text}
      </p>
      {long && (
        <Button variant="link" size="sm" onClick={() => setOpen((o) => !o)}>
          {open
            ? "Show less"
            : `Show the whole request (${text.length.toLocaleString("en-US")} characters)`}
        </Button>
      )}
    </div>
  );
}

/** The fact-check's gate badge: asking for changes is not a failure of the check itself. */
function factCheckResult(f: R): "passed" | "request_changes" | "failed" {
  if (f.gatePassed === true) return "passed";
  return f.verdict === "request_changes" ? "request_changes" : "failed";
}
