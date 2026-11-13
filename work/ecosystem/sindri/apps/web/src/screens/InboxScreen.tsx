import { useRef, useState, type ReactNode } from "react";
import type { Intake, IntakeComment } from "../api/types.js";
import {
  Cluster,
  EmptyState,
  formatRelative,
  Link,
  Page,
  RecordList,
  RecordRow,
  SegmentedControl,
  SplitView,
  Stack,
  Tabs,
} from "@factory/ui";
import {
  Badge,
  Button,
  Card,
  DetailHeading,
  Field,
  inputClass,
  LoadState,
  ScreenHeader,
  Status,
  textareaClass,
  Timestamp,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";
import { WorkKindBadge } from "../components/WorkKind.js";
import { PrReviewForm, ResearchForm } from "./WorkForms.js";

/** `tooltip` off inside list rows: a row is one button and must not hold another tab stop. */
export function SourceBadge({
  source,
  tooltip = true,
}: {
  source: Intake["source"];
  tooltip?: boolean;
}) {
  const labels: Record<string, string> = {
    manual: "Manual",
    jira: "Jira",
    linear: "Linear",
    github: "GitHub",
  };
  const label = labels[source] ?? source;
  return (
    <Badge
      tone={source === "manual" ? "neutral" : "info"}
      tooltip={
        !tooltip
          ? undefined
          : source === "manual"
            ? "Typed in here"
            : `Imported read-only from ${label}`
      }
    >
      {label}
    </Badge>
  );
}

export function InboxScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const list = useLoad(projectId ? () => api.listIntakes(projectId) : null, [projectId]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [addTab, setAddTab] = useState("manual");
  const [kind, setKind] = useState("change");
  const github = useLoad(() => api.githubStatus(), [], { live: false });
  const prUnavailable =
    github.state.status !== "ready"
      ? null
      : github.state.data.localOnly
        ? "Reviewing a pull request needs GitHub, and local-only mode is on (Settings)."
        : !github.state.data.enabled
          ? "GitHub pull requests are turned off in settings."
          : !github.state.data.ghInstalled
            ? "Reviewing a pull request needs the GitHub CLI (gh), signed in. Install it and run gh auth login."
            : null;
  // Phones show one pane: the list, or (when set) the add form or the opened item.
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState<{ intake: Intake; comments: IntakeComment[] } | null>(
    null,
  );
  const wanted = useRef<string | null>(null);

  const header = (
    <ScreenHeader
      screen="inbox"
      title="Inbox"
      term="Inbox"
      description="Ideas and tickets waiting to become specs. Add one by hand or import a Jira or Linear ticket."
      {...(projectId
        ? {
            actions: (
              <Button
                icon="plus"
                onClick={() => {
                  wanted.current = null;
                  setSelected(null);
                  setComposing(true);
                }}
              >
                Add item
              </Button>
            ),
          }
        : {})}
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

  // The item clicked last wins, whichever answer arrives last.
  const open = (id: string) => {
    wanted.current = id;
    setComposing(false);
    return run(async () => {
      const detail = await api.getIntake(id);
      if (wanted.current === id) setSelected(detail);
    });
  };

  const added = (intake: Intake, verb: string) => {
    list.reload();
    const elsewhere = intake.projectId !== projectId;
    const where = elsewhere
      ? ` to ${state.projects.find((p) => p.id === intake.projectId)?.name ?? "another project"}`
      : "";
    dispatch({
      type: "notice",
      notice: { kind: "info", text: `${verb} "${intake.display.title}"${where}` },
    });
  };

  const changeForms = (
    <Tabs
      label="How to add"
      value={addTab}
      onValueChange={setAddTab}
      items={[
        {
          value: "manual",
          label: "New idea or ticket",
          content: (
            <form
              aria-label="Manual intake"
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const intake = await api.createIntake({
                    projectId,
                    title: title.trim(),
                    body,
                  });
                  setTitle("");
                  setBody("");
                  list.reload();
                  dispatch({
                    type: "notice",
                    notice: {
                      kind: "info",
                      text: `Added "${intake.display.title}" to the inbox`,
                    },
                  });
                });
              }}
            >
              <Field label="Title" id="intake-title">
                <input
                  id="intake-title"
                  className={inputClass}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Description" id="intake-body">
                <textarea
                  id="intake-body"
                  rows={5}
                  className={textareaClass}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  type="submit"
                  disabled={busy}
                  {...(!busy && !title.trim() ? { disabledReason: "Give it a title first." } : {})}
                >
                  Add to inbox
                </Button>
              </div>
            </form>
          ),
        },
        {
          value: "import",
          label: "Import a ticket",
          content: (
            <form
              aria-label="Import by URL"
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const intake = await api.importIntake({ projectId, url: url.trim() });
                  setUrl("");
                  list.reload();
                  dispatch({
                    type: "notice",
                    notice: { kind: "info", text: `Imported "${intake.display.title}"` },
                  });
                });
              }}
            >
              <Field
                label="Jira or Linear URL"
                id="intake-url"
                term="Connector"
                hint="Read-only import. Disabled while local-only mode is on (see Settings)."
              >
                <input
                  id="intake-url"
                  type="url"
                  aria-describedby="intake-url-hint"
                  className={inputClass}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <div>
                <Button
                  type="submit"
                  disabled={busy}
                  {...(!busy && !url.trim() ? { disabledReason: "Paste a ticket URL first." } : {})}
                >
                  Import
                </Button>
              </div>
            </form>
          ),
        },
      ]}
    />
  );

  const composer = (
    <Card title="Add to the inbox" term="Intake">
      <SegmentedControl
        label="Kind of work"
        value={kind}
        onValueChange={setKind}
        options={[
          { value: "change", label: "Change" },
          { value: "research", label: "Research" },
          { value: "pr_review", label: "Review a PR", disabled: prUnavailable !== null },
        ]}
      />
      {prUnavailable ? (
        <p className="text-xs text-muted" id="pr-unavailable">
          Review a PR is unavailable: {prUnavailable}
        </p>
      ) : null}
      {kind === "research" ? (
        <ResearchForm
          projectId={projectId}
          localOnly={github.state.status === "ready" && github.state.data.localOnly}
          onCreated={(i) => added(i, "Added research question")}
        />
      ) : kind === "pr_review" && !prUnavailable ? (
        <PrReviewForm projectId={projectId} onCreated={(i) => added(i, "Imported pull request")} />
      ) : (
        changeForms
      )}
    </Card>
  );

  return (
    <Page>
      {header}
      <SplitView
        showDetail={selected !== null || composing}
        onBack={() => {
          wanted.current = null;
          setSelected(null);
          setComposing(false);
        }}
        backLabel="All inbox items"
        list={
          <Card
            title="Inbox items"
            headingLevel={2}
            flush
            {...(list.state.status === "ready" ? { count: list.state.data.length } : {})}
          >
            <LoadState state={list.state} what="the inbox" onRetry={list.reload}>
              {(items) =>
                items.length === 0 ? (
                  <EmptyState
                    compact
                    className="m-4"
                    title="The inbox is empty."
                    body="Add an idea or import a ticket to start a spec from it."
                  />
                ) : (
                  <RecordList label="Inbox items">
                    {items.map((i) => (
                      <RecordRow
                        key={i.id}
                        title={i.display.title}
                        meta={
                          <span className="inline-flex items-center gap-2">
                            <WorkKindBadge kind={i.workKind} tooltip={false} />
                            <SourceBadge source={i.source} tooltip={false} />
                            {i.externalId ? <span>{i.externalId}</span> : null}
                            <span>added {formatRelative(new Date(i.createdAt))}</span>
                          </span>
                        }
                        status={
                          i.syncState !== "imported" ? (
                            <Status value={i.syncState} domain="intake-sync" tooltip={false} />
                          ) : undefined
                        }
                        selected={selected?.intake.id === i.id}
                        onClick={() => void open(i.id)}
                      />
                    ))}
                  </RecordList>
                )
              }
            </LoadState>
          </Card>
        }
        detail={
          selected ? (
            <IntakeDetail
              {...selected}
              onDraft={() =>
                dispatch({
                  type: "director/open",
                  intakeId: selected.intake.id,
                  request: selected.intake.display.title,
                })
              }
            />
          ) : (
            composer
          )
        }
      />
    </Page>
  );
}

function IntakeDetail({
  intake,
  comments,
  onDraft,
}: {
  intake: Intake;
  comments: IntakeComment[];
  onDraft: () => void;
}) {
  return (
    <article aria-label="Intake detail" className="flex min-w-0 flex-col gap-6">
      <Stack gap={3}>
        <Cluster gap={3} justify="between" align="start">
          <Cluster gap={3} className="min-w-0">
            <DetailHeading>{intake.display.title}</DetailHeading>
            <WorkKindBadge kind={intake.workKind} />
            <SourceBadge source={intake.source} />
            {intake.syncState !== "imported" ? (
              <Status value={intake.syncState} domain="intake-sync" />
            ) : null}
          </Cluster>
          <Button onClick={onDraft}>Draft spec from this</Button>
        </Cluster>
        {intake.externalUrl ? (
          <p className="text-sm text-muted [overflow-wrap:anywhere]">
            {intake.externalId} ·{" "}
            <Link
              href={intake.externalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs text-accent-fg underline underline-offset-2 hover:decoration-2"
            >
              {intake.externalUrl}
            </Link>
          </p>
        ) : null}
        <p className="text-sm text-muted">
          Added <Timestamp value={intake.createdAt} />
        </p>
      </Stack>
      <Card
        title="Description"
        description="Untrusted text, shown sanitized. It is never executed or treated as instructions."
      >
        <pre className="rounded-md bg-sunken p-3 font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {intake.display.body || "(no description)"}
        </pre>
      </Card>
      {intake.pullRequest ? <PullRequestCard pr={intake.pullRequest} /> : null}
      <WorkDetails intake={intake} />
      {comments.length > 0 ? (
        <Card title="Comments" count={comments.length}>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {comments.map((c) => (
              <li key={c.id} className="py-2 [overflow-wrap:anywhere] first:pt-0 last:pb-0">
                <span className="font-medium">{c.display.author}</span> <Badge>{c.origin}</Badge>:{" "}
                {c.display.body}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </article>
  );
}

const SOURCE_NAMES: [keyof NonNullable<NonNullable<Intake["research"]>["sources"]>, string][] = [
  ["code", "Project code"],
  ["feedbackGraph", "Lessons from your feedback history"],
  ["web", "Web"],
];

/** Research sources, notes and skills an intake carries, when it carries any. */
function WorkDetails({ intake }: { intake: Intake }) {
  const sources = intake.research?.sources;
  const items: { label: string; value: string }[] = [];
  if (intake.workKind === "research" && intake.research) {
    items.push({
      label: "Sources",
      value:
        SOURCE_NAMES.filter(([k]) => sources?.[k])
          .map(([, n]) => n)
          .join(", ") || "Defaults",
    });
    items.push({ label: "Fact-check", value: intake.research.factCheck === false ? "Off" : "On" });
  }
  if (intake.skillIds?.length)
    items.push({ label: "Skills", value: `${intake.skillIds.length} selected` });
  if (intake.linkedExecutionId)
    items.push({ label: "Follows up on", value: `Delivery ${intake.linkedExecutionId}` });
  if (!items.length && !intake.notes) return null;
  return (
    <Card title="Work details">
      {items.length ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {items.map((i) => (
            <div key={i.label} className="contents">
              <dt className="text-muted">{i.label}</dt>
              <dd className="[overflow-wrap:anywhere]">{i.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {intake.notes ? (
        <pre className="rounded-md bg-sunken p-3 font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {intake.notes}
        </pre>
      ) : null}
    </Card>
  );
}

function PullRequestCard({ pr }: { pr: NonNullable<Intake["pullRequest"]> }) {
  const items: [string, ReactNode][] = [
    [
      "Pull request",
      <Link
        key="pr"
        href={pr.url}
        target="_blank"
        rel="noreferrer noopener"
        className="font-mono text-accent-fg underline underline-offset-2"
      >
        {pr.owner}/{pr.repo}#{pr.number}
        <span className="sr-only"> (opens in a new tab)</span>
      </Link>,
    ],
    ["Author", pr.author],
    ["State", pr.state],
    ["Branches", `${pr.headRef} → ${pr.baseRef}${pr.isCrossRepository ? " (from a fork)" : ""}`],
    ["Head", <code key="head">{pr.headSha.slice(0, 12)}</code>],
    ["Size", `${pr.changedFiles} files, +${pr.additions} −${pr.deletions}`],
  ];
  return (
    <Card
      title="Pull request"
      description="Read with your gh login. Re-import the URL to refresh it."
    >
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {items.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
