// Inspector views for research and PR review deliveries. A research document is decided here
// (accept, reject, follow-up) through the command dialog; a PR review is read here and edited and
// posted in Sindri, which holds the posting approval.
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
import { useDetail, WorkKindBadge } from "./WorkForms";
import {
  docSources,
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
  const access = actionBlock("research.accept", undefined, session);
  const decided = decision
    ? `This document was already ${decision.decision}.`
    : "";
  const rejectWhy = access || decided;
  const acceptWhy =
    rejectWhy || (checksFailed ? "The quality checks have not passed." : "");
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
        {research.question && (
          <p className="text-sm font-medium [overflow-wrap:anywhere]">
            {research.question}
          </p>
        )}
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
        <Cluster gap={2}>
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
        </Cluster>
        <p className="text-xs text-muted">
          The reason you give when you confirm is sent to Sindri with your
          decision. A rejection needs one.
        </p>
        <Reasons reasons={[acceptWhy, rejectWhy]} />
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
                  <span>{verdictLabel(research.factCheck.verdict)}</span>
                  {typeof research.factCheck.gatePassed === "boolean" && (
                    <Status
                      value={
                        research.factCheck.gatePassed ? "passed" : "failed"
                      }
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
          <FindingsTable
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
            href={sindriDeliveryHref(projectId, executionId)}
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
