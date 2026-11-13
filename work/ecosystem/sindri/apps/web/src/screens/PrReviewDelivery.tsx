import {
  Cluster,
  CodeBlock,
  Disclosure,
  FindingsTable,
  findingLocation,
  Markdown,
  Stack,
  Tabs,
  type Finding,
} from "@factory/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import type { DeliveryDetail } from "../api/delivery-types.js";
import type {
  LeakCheck,
  PrReviewFinding,
  PrReviewReport,
  ReviewPreview,
  ReviewVerdict,
} from "../api/work-types.js";
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
  inputClass,
  LoadState,
  Status,
  textareaClass,
  Timestamp,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";
import { GuidanceUsedCard } from "./GuidanceUsed.js";
import { APPROVALS_LOCKED } from "./RunsScreen.js";

const VERDICTS: [ReviewVerdict, string][] = [
  ["comment", "Comment"],
  ["approve", "Approve"],
  ["request_changes", "Request changes"],
];
const verdictLabel = (v: string | null) =>
  VERDICTS.find(([k]) => k === v?.toLowerCase())?.[1] ?? v ?? "None";

const BLOCKERS: Record<string, string> = {
  gates_not_passed: "The reviewers' checks have not passed.",
  post_blocked: "The leak check found text that must stay local.",
  already_posted: "This review is already on the pull request.",
};

const LEAK_RULES: Record<string, string> = {
  private_tooling: "names private local tooling",
  lesson_reference: "cites a private lesson",
};
const leakRule = (rule: string) =>
  LEAK_RULES[rule] ??
  (rule.startsWith("secret:") ? `looks like a secret (${rule.slice(7)})` : rule);

interface Draft {
  verdict: ReviewVerdict;
  summary: string;
  findings: PrReviewFinding[];
}

const draftOf = (review: PrReviewReport): Draft => ({
  verdict: VERDICTS.some(([v]) => v === review.draft.verdict)
    ? (review.draft.verdict as ReviewVerdict)
    : "comment",
  summary: review.draft.summary,
  findings: review.draft.findings,
});

/** The placement note shows under the message, next to the category. */
const toFinding = (f: PrReviewFinding): Finding => {
  const note = [f.category, f.placementNote].filter(Boolean).join(" · ");
  return {
    id: f.id,
    severity: f.severity,
    message: f.message,
    included: f.included,
    placement: f.placement === "inline" ? "inline" : "general",
    ...(note ? { category: note } : {}),
    ...(f.file ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  };
};

interface Problem {
  title: string;
  body: ReactNode;
  tone: "warning" | "danger";
  /** A leak-check hit, to point at the finding. */
  leak?: { rule: string; findingId: string | null; field?: string };
}

const short = (sha: unknown) => (typeof sha === "string" ? sha.slice(0, 12) : "unknown");

/** Clear text for every error the review routes answer; null for anything else. */
function reviewProblem(err: ApiError): Problem | null {
  const d = (err.details ?? {}) as Record<string, unknown>;
  switch (err.code) {
    case "post_in_progress":
      return {
        tone: "warning",
        title: "This review is being posted already",
        body: "Another request is posting it right now. Wait a moment, then refresh.",
      };
    case "gates_not_passed":
      return {
        tone: "danger",
        title: "The review did not pass its checks",
        body: "A review whose checks failed cannot be posted. Run the review again.",
      };
    case "pr_head_moved":
      return {
        tone: "warning",
        title: "The pull request changed since this review",
        body: `It was reviewed at ${short(d["reviewedSha"])}; the pull request is now at ${short(d["currentSha"])}. Nothing was posted. Import the pull request again from the Inbox (Review a PR) and run a new review; this one stays here, unposted.`,
      };
    case "post_blocked":
      return {
        tone: "danger",
        title: "Posting is blocked by the leak check",
        body: null,
        leak: {
          rule: typeof d["rule"] === "string" ? d["rule"] : "unknown",
          findingId: typeof d["findingId"] === "string" ? d["findingId"] : null,
          ...(typeof d["field"] === "string" ? { field: d["field"] } : {}),
        },
      };
    case "local_only":
      return {
        tone: "warning",
        title: "Local-only mode is on",
        body: "Posting to GitHub is turned off while local-only mode is on (Settings → General).",
      };
    case "github_error":
      return {
        tone: "danger",
        title: "GitHub refused the review",
        body: `gh failed while posting: ${err.message}. Check the pull request on GitHub before trying again.`,
      };
    case "approval_required":
      return {
        tone: "warning",
        title: "Approvals are locked",
        body: "The approval session ended. Enter the pairing code again, then post.",
      };
    default:
      return null;
  }
}

/**
 * A local PR review: edit the draft (verdict, summary, findings), preview exactly what would be
 * posted, and post it to GitHub only with the approval secret.
 */
export function PrReviewDelivery({
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
  const review = detail.report.review as PrReviewReport;
  const [draft, setDraft] = useState<Draft>(() => draftOf(review));
  const [version, setVersion] = useState(review.draft.version);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<string | null>(review.posted?.htmlUrl ?? null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [tab, setTab] = useState("review");
  const [, setUnlockTick] = useState(0);
  const preview = useLoad(() => api.previewReview(deliveryId), [deliveryId, previewTick], {
    live: false,
  });
  const locked = !api.hasApprovalSession();
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });

  // A live refresh replaces the draft only while it has no unsaved edits.
  const seeded = useRef(review);
  useEffect(() => {
    if (seeded.current === review) return;
    seeded.current = review;
    if (!dirty) {
      setDraft(draftOf(review));
      setVersion(review.draft.version);
    }
    if (review.posted) setPosted(review.posted.htmlUrl);
  }, [review, dirty]);

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const refreshPreview = () => setPreviewTick((n) => n + 1);

  const save = () => {
    setSaving(true);
    api
      .saveReview(deliveryId, {
        verdict: draft.verdict,
        summary: draft.summary,
        findings: draft.findings.map((f) => ({
          id: f.id,
          included: f.included,
          message: f.message,
        })),
      })
      .then(
        (saved) => {
          // The prop is stale until the reload lands; only a newer report reseeds the draft.
          seeded.current = review;
          setDraft(draftOf(saved));
          setVersion(saved.draft.version);
          setDirty(false);
          setProblem(null);
          refreshPreview();
          notify(`Review saved as draft version ${saved.draft.version}`);
          reload();
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.code === "already_posted") {
            const url = (err.details as { htmlUrl?: string } | undefined)?.htmlUrl;
            setPosted(url ?? "");
            notify("This review was already posted; edits can no longer be saved");
          } else if (err instanceof ApiError && err.code === "validation_failed")
            setProblem({
              tone: "warning",
              title: "Some findings no longer exist",
              body: `${err.message}. The review changed on the server; reload the page to get the current findings.`,
            });
          else report(err);
        },
      )
      .finally(() => setSaving(false));
  };

  const post = () => {
    setPosting(true);
    setProblem(null);
    api
      .postReview(deliveryId)
      .then(
        ({ posted: p }) => {
          setPosted(p.htmlUrl);
          notify("Review posted to GitHub");
          reload();
        },
        (err: unknown) => {
          if (!(err instanceof ApiError)) return report(err);
          if (err.code === "already_posted") {
            setPosted((err.details as { htmlUrl?: string } | undefined)?.htmlUrl ?? "");
            notify("This review was already posted");
            return;
          }
          const p = reviewProblem(err);
          if (!p) return report(err);
          setProblem(p);
          if (p.leak) refreshPreview();
        },
      )
      .finally(() => setPosting(false));
  };

  const pv: ReviewPreview | null = preview.state.status === "ready" ? preview.state.data : null;
  const previewLeak: LeakCheck | undefined = pv && !pv.leakCheck.ok ? pv.leakCheck : undefined;
  const leak = problem?.leak ?? (previewLeak && !previewLeak.ok ? previewLeak : undefined);
  const leakFinding = leak?.findingId
    ? draft.findings.find((f) => f.id === leak.findingId)
    : undefined;
  const stalePreview = pv !== null && pv.draftVersion !== version;
  const postReason =
    posted !== null
      ? "Already posted."
      : dirty
        ? "Save your edits first."
        : locked
          ? APPROVALS_LOCKED
          : !pv
            ? "Load the preview first."
            : stalePreview
              ? "Refresh the preview first."
              : !pv.canPost
                ? (BLOCKERS[pv.blockers[0] ?? ""] ?? pv.blockers.join(", "))
                : undefined;
  const pr = review.pr;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Stack gap={3}>
        <Cluster gap={3} className="min-w-0">
          <DetailHeading>{pr.title || `${pr.owner}/${pr.repo}#${pr.number}`}</DetailHeading>
          <WorkKindBadge kind="pr_review" />
          {posted !== null ? <Badge tone="ok">Posted</Badge> : <Badge>Local only</Badge>}
        </Cluster>
        <p className="text-sm text-muted [overflow-wrap:anywhere]">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-accent-fg underline underline-offset-2 hover:decoration-2"
          >
            {pr.owner}/{pr.repo}#{pr.number}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>{" "}
          · base <code>{short(pr.baseSha)}</code> · head <code>{short(pr.headSha)}</code>
        </p>
        <p className="text-sm text-muted">
          Draft version {version}
          {review.draft.editedBy && review.draft.editedAt ? (
            <>
              {" "}
              · edited by {review.draft.editedBy}, <Timestamp value={review.draft.editedAt} />
            </>
          ) : version === 0 ? (
            " · the agent's review, unedited"
          ) : null}
        </p>
        {posted !== null ? (
          <Callout tone="success" title="Posted to GitHub">
            {posted ? (
              <a
                href={posted}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent-fg underline underline-offset-2 [overflow-wrap:anywhere]"
              >
                {posted}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              "The review is on the pull request."
            )}
          </Callout>
        ) : null}
        {!review.gatePassed ? (
          <Callout tone="warning" title="The reviewers' checks did not pass">
            <GateFailureList failures={review.gateFailures} />
          </Callout>
        ) : null}
        {!review.hunksAvailable ? (
          <Callout tone="info" title="The pull request diff could not be read">
            Every finding is posted as a general comment instead of on a line.
          </Callout>
        ) : null}
        {problem && !problem.leak ? (
          <Callout tone={problem.tone} title={problem.title}>
            {problem.body}
          </Callout>
        ) : null}
        {leak && posted === null ? (
          <Callout tone="danger" title="Posting is blocked by the leak check">
            <span className="[overflow-wrap:anywhere]">
              The {leak.findingId ? (leak.field ?? "text") : "summary"} {leakRule(leak.rule)} (rule{" "}
              <code>{leak.rule}</code>)
              {leakFinding ? (
                <>
                  {" "}
                  in finding <strong>{findingLocation(toFinding(leakFinding))}</strong>: “
                  {leakFinding.message}”. Edit or exclude it, then save.
                </>
              ) : (
                ". Edit it, then save."
              )}
            </span>
            {leakFinding?.included ? (
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    edit({
                      findings: draft.findings.map((f) =>
                        f.id === leakFinding.id ? { ...f, included: false } : f,
                      ),
                    })
                  }
                >
                  Exclude this finding
                </Button>
              </div>
            ) : null}
          </Callout>
        ) : null}
      </Stack>
      <Tabs
        label="Review sections"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: "review",
            label: "Review",
            content: (
              <Stack gap={4}>
                <Card title="Review" description="Nothing leaves this machine until you post it.">
                  <Field label="Verdict" id="review-verdict">
                    <select
                      id="review-verdict"
                      className={inputClass}
                      value={draft.verdict}
                      disabled={posted !== null}
                      onChange={(e) => edit({ verdict: e.target.value as ReviewVerdict })}
                    >
                      {VERDICTS.map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Summary" id="review-summary">
                    <textarea
                      id="review-summary"
                      rows={5}
                      className={textareaClass}
                      value={draft.summary}
                      readOnly={posted !== null}
                      onChange={(e) => edit({ summary: e.target.value })}
                    />
                  </Field>
                </Card>
                <Card
                  title="Findings"
                  count={draft.findings.length}
                  description="Untick a finding to leave it out; Edit rewords it. General findings go into the review body."
                  flush
                >
                  <div className={leakFinding ? "rounded-md ring-2 ring-danger-fg/40" : undefined}>
                    <FindingsTable
                      findings={draft.findings.map(toFinding)}
                      editable={posted === null}
                      caption="Review findings"
                      emptyText="The reviewers found nothing to comment on."
                      onChange={(f) =>
                        edit({
                          findings: draft.findings.map((x) =>
                            x.id === f.id
                              ? { ...x, message: f.message, included: f.included ?? x.included }
                              : x,
                          ),
                        })
                      }
                    />
                  </div>
                </Card>
                {posted === null ? (
                  <Cluster gap={2}>
                    <Button
                      variant="secondary"
                      loading={saving}
                      disabled={posting}
                      {...(!dirty && !saving ? { disabledReason: "No unsaved edits." } : {})}
                      onClick={save}
                    >
                      Save edits
                    </Button>
                    <span role="status" className="text-sm text-muted">
                      {saving ? "Saving…" : dirty ? "Unsaved edits" : "All edits saved"}
                    </span>
                  </Cluster>
                ) : null}
              </Stack>
            ),
          },
          {
            value: "preview",
            label: "Preview and post",
            content: (
              <Stack gap={4}>
                <Card
                  title="What will be posted"
                  description="Exactly what GitHub receives from your gh login, shown as plain text."
                  actions={
                    <Button variant="secondary" size="sm" onClick={refreshPreview}>
                      Refresh preview
                    </Button>
                  }
                >
                  {dirty ? (
                    <Callout tone="info" title="Unsaved edits">
                      The preview shows the last saved version. Save your edits to see them here.
                    </Callout>
                  ) : stalePreview ? (
                    <Callout tone="info" title="The preview is out of date">
                      It shows draft version {pv?.draftVersion}; the draft is now version {version}.
                      Refresh the preview.
                    </Callout>
                  ) : null}
                  <LoadState state={preview.state} what="preview" onRetry={preview.reload}>
                    {(p) => <PreviewBody preview={p} />}
                  </LoadState>
                </Card>
                {posted === null ? (
                  <Card title="Post to GitHub">
                    {locked ? (
                      <ApprovalUnlock
                        id="review-approval-code"
                        onUnlocked={() => setUnlockTick((n) => n + 1)}
                      />
                    ) : null}
                    <div>
                      <Button
                        loading={posting}
                        disabled={saving || posting}
                        {...(postReason && !posting ? { disabledReason: postReason } : {})}
                        onClick={post}
                      >
                        Post review to GitHub
                      </Button>
                    </div>
                  </Card>
                ) : null}
              </Stack>
            ),
          },
          {
            value: "reviewers",
            label: "Reviewers",
            count: review.reviews.length,
            content: <Reviewers reviews={review.reviews} />,
          },
          {
            value: "guidance",
            label: "Guidance",
            content: <GuidanceUsedCard guidance={detail.report.guidance} />,
          },
        ]}
      />
    </div>
  );
}

/** The payload is not display sanitized: everything here is rendered as text. */
function PreviewBody({ preview: p }: { preview: ReviewPreview }) {
  return (
    <section aria-label="Review preview" className="flex flex-col gap-3">
      {p.canPost ? (
        <Callout tone="success" title="Ready to post" />
      ) : (
        <Callout tone="warning" title="Cannot be posted yet">
          <ul aria-label="Blockers" className="ml-4 list-disc">
            {p.blockers.map((b) => (
              <li key={b}>{BLOCKERS[b] ?? b}</li>
            ))}
          </ul>
        </Callout>
      )}
      <p className="text-sm">
        {p.leakCheck.ok ? "Leak check passed" : "Leak check failed"} · checks{" "}
        {p.gatesPassed ? "passed" : "failed"} · draft version {p.draftVersion} · verdict{" "}
        <strong>{verdictLabel(p.payload.event)}</strong> · commit{" "}
        <code>{short(p.payload.commit_id)}</code>
      </p>
      <CodeBlock title="Review body" code={p.payload.body || "(empty)"} />
      {p.payload.comments.length === 0 ? (
        <Empty>No inline comments.</Empty>
      ) : (
        <ul aria-label="Inline comments" className="flex flex-col gap-2">
          {p.payload.comments.map((c, i) => (
            <li key={`${c.path}:${c.line}:${i}`}>
              <CodeBlock
                title={`${c.path}:${c.start_line !== undefined ? `${c.start_line}-` : ""}${c.line} (${c.side === "LEFT" ? "old" : "new"} side)`}
                code={c.body}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Reviewers({ reviews }: { reviews: PrReviewReport["reviews"] }) {
  if (reviews.length === 0)
    return (
      <Card title="Reviewers">
        <Empty>No reviewer output was recorded.</Empty>
      </Card>
    );
  return (
    <Stack gap={4}>
      {reviews.map((r) => (
        <Card key={r.planTaskId} title={`${r.role} review (${r.planTaskId})`}>
          <Cluster gap={2}>
            <Badge>Verdict: {verdictLabel(r.verdict)}</Badge>
            <Status
              value={r.gatePassed === null ? "not_evaluated" : r.gatePassed ? "passed" : "failed"}
              domain="gate"
              tooltip={false}
            />
          </Cluster>
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {r.summary || "No summary."}
          </p>
          {r.markdown ? (
            <Disclosure title="Show the full review.md">
              <Markdown source={r.markdown} />
            </Disclosure>
          ) : null}
        </Card>
      ))}
    </Stack>
  );
}
