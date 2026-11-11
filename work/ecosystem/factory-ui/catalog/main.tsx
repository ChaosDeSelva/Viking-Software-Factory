import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  CardGroup,
  Checkbox,
  CodeBlock,
  Combobox,
  CommandPalette,
  ConfirmDialog,
  DataTable,
  Dialog,
  Disclosure,
  DocsView,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  GlossaryProvider,
  GuideChat,
  IconButton,
  Id,
  InfoHint,
  Input,
  KeyValue,
  LoadState,
  LogView,
  MetricCard,
  Page,
  PageHeader,
  Pagination,
  Progress,
  RecordList,
  RecordRow,
  ROLE_MEANING,
  ROLE_NAMES,
  Section,
  SegmentedControl,
  Select,
  SkeletonCard,
  SplitView,
  StatusPill,
  Stepper,
  StickyActionBar,
  Switch,
  Tabs,
  Textarea,
  Timeline,
  Timestamp,
  Toolbar,
  Tooltip,
  useCommandShortcut,
  useToast,
  type Column,
  type SortState,
  type StatusRole,
} from "../src/index.js";
import "./catalog.css";

// Illustrative data only; fixed "now" keeps screenshots stable.
const NOW = new Date("2026-11-11T14:30:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const glossary = [
  {
    term: "Steward",
    short:
      "The autonomy agent that proposes (or, in Automatic mode, makes) routine decisions for you.",
  },
  {
    term: "Run",
    short:
      "One execution of an approved plan: Mimir works through its tasks and Brokkr verifies the result.",
  },
  { term: "Quality gate", short: "Checks a run must pass before it can be delivered." },
  { term: "Project", short: "A repository the factory plans and delivers work for." },
  { term: "Harness", short: "The set of checks Brokkr runs against a change." },
];

const projects = [
  { id: "p1", name: "demo-app", description: "Web storefront" },
  { id: "p2", name: "acme-billing", description: "Invoices and payments" },
  { id: "p3", name: "hello-factory", description: "Sample project" },
  { id: "p4", name: "acme-search" },
  { id: "p5", name: "acme-mobile" },
];

interface RunRow {
  id: string;
  name: string;
  status: string;
  tasks: number;
  failed: number;
  updated: string;
}
const runs: RunRow[] = [
  {
    id: "0e7c1f2a-93b1-4a77-9f3e-6c1d2b8a9f01",
    name: "Add greeting endpoint",
    status: "running",
    tasks: 6,
    failed: 0,
    updated: ago(2),
  },
  {
    id: "4b1d9c3e-11aa-4c3b-8d2e-90ab12cd34ef",
    name: "Fix invoice rounding",
    status: "verified_pending_review",
    tasks: 4,
    failed: 1,
    updated: ago(38),
  },
  {
    id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
    name: "Search ranking tweaks",
    status: "failed",
    tasks: 9,
    failed: 3,
    updated: ago(190),
  },
  {
    id: "1f2e3d4c-5b6a-4987-8a7b-6c5d4e3f2a1b",
    name: "Upgrade the date library",
    status: "delivered_pending_merge",
    tasks: 3,
    failed: 0,
    updated: ago(1500),
  },
  {
    id: "aa11bb22-cc33-4d44-8e55-ff6677889900",
    name: "Retire the old export job",
    status: "cancelled",
    tasks: 2,
    failed: 0,
    updated: ago(4000),
  },
];

const samples: Record<string, string[]> = {
  sindri: [
    "draft",
    "running",
    "awaiting_human",
    "verified_pending_review",
    "delivered_pending_merge",
    "blocked",
    "failed",
    "superseded",
  ],
  mimir: ["ready", "leased", "verifying", "completed", "paused", "rejected", "archived", "unknown"],
  heimdall: [
    "received",
    "busy",
    "awaiting_approval",
    "connected",
    "stale",
    "not configured",
    "Paired",
    "teleporting",
  ],
  skidbladnir: [
    "requested",
    "terminating",
    "Success",
    "stopped",
    "TimedOut",
    "Cancelled",
    "terminated",
    "provisioning",
  ],
};

function Swatches() {
  return (
    <CardGroup min={260}>
      {ROLE_NAMES.map((role: StatusRole) => (
        <div
          key={role}
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-card-dense"
        >
          <span className="flex items-center gap-2">
            <span
              className="size-6 rounded-md border"
              style={{
                background: `var(--status-${role}-bg)`,
                borderColor: `var(--status-${role}-border)`,
                borderStyle: role === "unknown" ? "dashed" : "solid",
              }}
            />
            <span className="text-sm font-semibold" style={{ color: `var(--status-${role}-fg)` }}>
              {role}
            </span>
          </span>
          <span className="text-xs text-muted">{ROLE_MEANING[role]}</span>
        </div>
      ))}
    </CardGroup>
  );
}

function TypeAndSpace() {
  const sizes = [
    ["3xl", "36/44 · overview hero", "text-3xl"],
    ["2xl", "28/36 · page title", "text-2xl"],
    ["xl", "22/28 · section title", "text-xl"],
    ["lg", "18/28 · card title", "text-lg"],
    ["md", "16/24 · reading text", "text-md"],
    ["sm", "14/20 · UI default", "text-sm"],
    ["xs", "12/16 · meta, badges", "text-xs"],
  ] as const;
  return (
    <CardGroup min={360}>
      <Card title="Type scale" description="Weights 400, 500 and 600 only.">
        <ul className="flex flex-col gap-3">
          {sizes.map(([name, use, cls]) => (
            <li
              key={name}
              className="flex items-baseline justify-between gap-4 border-b border-line pb-3 last:border-0 last:pb-0"
            >
              <span className={`${cls} truncate font-semibold`}>Factory</span>
              <span className="shrink-0 text-xs text-muted">
                {name} · {use}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title="Spacing"
        description="4px scale. Card padding 20, gaps between cards 16, between sections 32."
      >
        <ul className="flex flex-col gap-2">
          {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
            <li key={n} className="grid grid-cols-[96px_1fr] items-center gap-3 text-xs text-muted">
              <span className="tabular-nums">
                space-{n} · {n * 4}
              </span>
              <span className="h-3 rounded-sm bg-accent-soft" style={{ width: n * 4 * 2 }} />
            </li>
          ))}
        </ul>
      </Card>
    </CardGroup>
  );
}

function Actions() {
  const [busy, setBusy] = useState(false);
  return (
    <CardGroup min={360}>
      <Card title="Buttons" description="Primary once per view; secondary for the rest.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" icon="plus">
              New work
            </Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Cancel run</Button>
            <Button variant="link">View details</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg" variant="primary">
              Large
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              loading={busy}
              onClick={() => {
                setBusy(true);
                setTimeout(() => setBusy(false), 1500);
              }}
            >
              {busy ? "Saving" : "Save (loading)"}
            </Button>
            <Button variant="primary" disabledReason="Unlock operator controls to approve.">
              Approve
            </Button>
            <Button disabled>Disabled</Button>
          </div>
        </div>
      </Card>
      <Card title="Icon buttons" description="Always labelled; the label is also the tooltip.">
        <div className="flex flex-wrap items-center gap-2">
          <IconButton icon="refresh" label="Refresh" />
          <IconButton icon="copy" label="Copy link" variant="secondary" />
          <IconButton icon="settings" label="Settings" variant="secondary" />
          <IconButton icon="x" label="Dismiss" size="sm" />
          <IconButton icon="external" label="Open in Mimir" />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Badge>implementer</Badge>
          <Badge tone="forest" tooltip="Recorded directly from the agent's output">
            observed
          </Badge>
          <Badge tone="info">derived</Badge>
          <Badge tone="accent">summarized</Badge>
          <Badge tone="warning">fixtures</Badge>
        </div>
      </Card>
    </CardGroup>
  );
}

function Forms() {
  const [harness, setHarness] = useState("codex");
  const [mission, setMission] = useState<string | null>("m2");
  const [mode, setMode] = useState("recommend");
  const [on, setOn] = useState(true);
  const [name, setName] = useState("");
  return (
    <CardGroup min={360}>
      <Card title="Fields" description="Label above, hint below, error replaces the hint.">
        <form className="flex flex-col gap-field" onSubmit={(e) => e.preventDefault()}>
          <Field label="Project name" hint="Lowercase, used in branch names." required>
            <Input placeholder="demo-app" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Repository URL" error="Enter a URL that starts with https://">
            <Input defaultValue="git@example" />
          </Field>
          <Field label="Search">
            <Input prefix="search" placeholder="Filter runs…" />
          </Field>
          <Field label="Notes for the steward" term="Steward">
            <Textarea placeholder="Prefer small, reviewable changes." />
          </Field>
        </form>
      </Card>
      <Card title="Choices">
        <div className="flex flex-col gap-field">
          <Field label="Agent harness" term="Harness">
            <Select
              value={harness}
              onValueChange={setHarness}
              options={[
                { value: "codex", label: "Codex" },
                { value: "claude", label: "Claude Code" },
                { value: "generic", label: "Generic shell" },
                { value: "off", label: "Unavailable harness", disabled: true },
              ]}
            />
          </Field>
          <Field label="Mission">
            <Combobox
              label="Mission"
              value={mission}
              onValueChange={setMission}
              options={[
                {
                  value: "m1",
                  label: "Greeting endpoint",
                  group: "Recent",
                  description: "demo-app",
                },
                {
                  value: "m2",
                  label: "Invoice rounding",
                  group: "Recent",
                  description: "acme-billing",
                },
                {
                  value: "m3",
                  label: "Search ranking",
                  group: "All missions",
                  description: "acme-search",
                },
                {
                  value: "m4",
                  label: "Date library upgrade",
                  group: "All missions",
                  description: "demo-app",
                },
              ]}
            />
          </Field>
          <div className="flex flex-col gap-label">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              Steward mode <InfoHint term="Steward" />
            </span>
            <SegmentedControl
              label="Steward mode"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "off", label: "Off" },
                { value: "recommend", label: "Recommend" },
                { value: "auto", label: "Automatic" },
              ]}
            />
          </div>
          <Switch
            checked={on}
            onCheckedChange={setOn}
            label="Notify me about escalations"
            description="Shows a toast and a count in the bottom bar."
          />
          <Checkbox
            label="Include archived projects"
            description="Archived projects are read-only."
          />
        </div>
      </Card>
    </CardGroup>
  );
}

function Data() {
  const [sort, setSort] = useState<SortState>({ key: "updated", direction: "desc" });
  const [selected, setSelected] = useState<string | undefined>(runs[1]!.id);
  const [page, setPage] = useState(3);
  const rows = useMemo(() => {
    const list = [...runs];
    list.sort((a, b) => {
      const k = sort.key as keyof RunRow;
      const r = String(a[k]).localeCompare(String(b[k]), undefined, { numeric: true });
      return sort.direction === "asc" ? r : -r;
    });
    return list;
  }, [sort]);
  const columns: Column<RunRow>[] = [
    { key: "name", header: "Run", primary: true, sortable: true, cell: (r) => r.name },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusPill app="sindri" value={r.status} tooltip={false} />,
    },
    { key: "tasks", header: "Tasks", align: "right", sortable: true, cell: (r) => r.tasks },
    { key: "failed", header: "Failed attempts", align: "right", cell: (r) => r.failed },
    {
      key: "id",
      header: "ID",
      hideOnMobile: true,
      cell: (r) => <Id value={r.id} label="Run ID" />,
    },
    {
      key: "updated",
      header: "Updated",
      sortable: true,
      cell: (r) => <Timestamp value={r.updated} now={NOW} />,
    },
  ];
  return (
    <div className="flex flex-col gap-group">
      <DataTable
        caption="Runs for demo-app"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={sort}
        onSortChange={setSort}
        onRowClick={(r) => setSelected(r.id)}
        rowLabel={(r) => `Open run ${r.name}`}
        selectedKey={selected}
      />
      <Pagination page={page} pageCount={12} onPageChange={setPage} />
      <CardGroup min={360}>
        <Card title="Loading" flush>
          <DataTable
            caption="Loading example"
            columns={columns.slice(0, 3)}
            rows={[]}
            rowKey={(r) => r.id}
            loading
            className="rounded-none border-0"
          />
        </Card>
        <Card title="Empty" flush>
          <DataTable
            caption="Empty example"
            columns={columns.slice(0, 3)}
            rows={[]}
            rowKey={(r) => r.id}
            className="rounded-none border-0"
            empty={
              <EmptyState
                compact
                className="m-4"
                title="No runs yet"
                body="Approve a plan to start the first run."
                action={
                  <Button size="sm" variant="primary">
                    Open plans
                  </Button>
                }
              />
            }
          />
        </Card>
      </CardGroup>
    </div>
  );
}

function Feedback() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  return (
    <div className="flex flex-col gap-group">
      <CardGroup min={360}>
        <Card title="Empty state">
          <EmptyState
            title="Nothing needs you"
            body="Runs that wait for a review or an answer will show up here."
            icon="check"
            action={<Button variant="primary">Open runs</Button>}
            secondaryAction={<Button variant="ghost">Read about reviews</Button>}
          />
        </Card>
        <Card title="Error state">
          <ErrorState
            title="Could not load runs"
            message="Sindri did not answer within 10 seconds."
            details={"GET /v1/executions?project=p1\n503 Service Unavailable"}
            onRetry={() => toast({ title: "Retrying…", tone: "info" })}
          />
        </Card>
      </CardGroup>
      <div className="flex flex-col gap-3">
        <Callout tone="info" title="Read-only session">
          You can look at everything but not approve or change it. Unlock operator controls from the
          bottom bar.
        </Callout>
        <Callout
          tone="warning"
          title="Budget almost used"
          action={<Button size="sm">Raise budget</Button>}
        >
          This run has used 92% of its task budget.
        </Callout>
        <Callout tone="danger" title="Quality gate failed">
          Two checks failed: lint and unit tests.
        </Callout>
        <Callout tone="success">Delivered. The branch is ready to merge.</Callout>
      </div>
      <CardGroup min={300}>
        <Card
          title="Skeleton and LoadState"
          actions={
            <Button size="sm" onClick={() => setLoading(!loading)}>
              Toggle
            </Button>
          }
        >
          <LoadState
            loading={loading}
            skeleton={<SkeletonCard lines={2} className="border-0 p-0" />}
          >
            <p className="text-sm">
              Loaded content replaces the skeleton; zeros are never shown as data.
            </p>
          </LoadState>
        </Card>
        <Card title="Toasts" description="Errors persist; success clears after 5 seconds.">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => toast({ title: "Plan approved", tone: "success" })}>
              Success
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast({ title: "Connection lost", description: "Reconnecting…", tone: "warning" })
              }
            >
              Warning
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast({
                  title: "Approval failed",
                  description: "The operator code expired.",
                  tone: "danger",
                  action: { label: "Retry", onClick: () => undefined },
                })
              }
            >
              Error
            </Button>
          </div>
        </Card>
      </CardGroup>
    </div>
  );
}

function Records() {
  const [sel, setSel] = useState("r2");
  return (
    <div className="flex flex-col gap-group">
      <CardGroup min={240}>
        <MetricCard
          label="Runs in progress"
          value={3}
          description="2 tasks verifying"
          href="#runs"
          term="Run"
        />
        <MetricCard
          label="Needs you"
          value={2}
          description="1 review, 1 question"
          href="#reviews"
          delta={{ value: "+1 today", tone: "neutral" }}
        />
        <MetricCard
          label="Delivered this week"
          value={7}
          delta={{ value: "+3", tone: "success" }}
        />
        <MetricCard label="Gate failures" value="—" loading />
      </CardGroup>
      <CardGroup min={360}>
        <Card
          title="Runs needing you"
          count={2}
          flush
          actions={
            <Button size="sm" variant="ghost">
              View all
            </Button>
          }
        >
          <RecordList label="Runs needing you">
            <RecordRow
              title="Fix invoice rounding"
              meta="acme-billing · checks passed 38 min ago"
              status={<StatusPill app="sindri" value="verified_pending_review" />}
              onClick={() => setSel("r1")}
              selected={sel === "r1"}
            />
            <RecordRow
              title="Search ranking tweaks: the agent asks whether to keep the legacy scorer"
              meta="acme-search · question from implementer"
              status={<StatusPill app="sindri" value="awaiting_human" />}
              onClick={() => setSel("r2")}
              selected={sel === "r2"}
            />
          </RecordList>
        </Card>
        <Card title="Run details">
          <KeyValue
            items={[
              { label: "Run", value: "Fix invoice rounding" },
              {
                label: "Status",
                value: <StatusPill app="sindri" value="verified_pending_review" />,
              },
              { label: "Run ID", value: <Id value={runs[1]!.id} label="Run ID" /> },
              { label: "Started", value: <Timestamp value={ago(95)} now={NOW} /> },
              {
                label: "Quality gate",
                term: "Quality gate",
                value: <StatusPill app="sindri" value="passed" />,
              },
              {
                label: "Progress",
                value: <Progress value={4} max={4} label="Tasks complete" showValue />,
              },
            ]}
          />
        </Card>
      </CardGroup>
      <Card title="New work" description="Stepper for multi-step flows.">
        <Stepper
          current={1}
          steps={[
            { id: "a", label: "Describe", description: "What should change" },
            { id: "b", label: "Review the spec", description: "Answer open questions" },
            { id: "c", label: "Approve the plan", description: "Then the run starts" },
          ]}
        />
      </Card>
      <CardGroup min={360}>
        <Card title="Activity">
          <Timeline
            now={NOW}
            items={[
              {
                id: "t1",
                time: ago(3),
                title: "Task verified",
                body: "Brokkr: 14 checks passed.",
                icon: "check",
                rawType: "task.verified",
              },
              {
                id: "t2",
                time: ago(25),
                title: "Implementer finished",
                body: "Changed 3 files.",
                icon: "guide",
                rawType: "session.completed",
              },
              {
                id: "t3",
                time: ago(1500),
                title: "Plan approved",
                body: "By the steward (Recommend → accepted).",
                icon: "check",
                rawType: "plan.approved",
              },
            ]}
          />
        </Card>
        <Card title="Event log">
          <LogView
            now={NOW}
            maxHeight="260px"
            entries={[
              {
                id: "l1",
                time: ago(9),
                type: "session.started",
                message: "implementer on worker-2",
              },
              { id: "l2", time: ago(8), type: "session.output", message: "running npm test" },
              { id: "l3", time: ago(8), type: "session.output", message: "running npm test" },
              { id: "l4", time: ago(8), type: "session.output", message: "running npm test" },
              {
                id: "l5",
                time: ago(6),
                level: "warn",
                type: "budget",
                message: "80% of the task budget used",
              },
              {
                id: "l6",
                time: ago(4),
                level: "error",
                type: "gate",
                message: "lint failed: 2 problems",
              },
              {
                id: "l7",
                time: ago(2),
                type: "task.verifying",
                message: "re-running checks after fix",
              },
            ]}
          />
        </Card>
      </CardGroup>
      <CardGroup min={360}>
        <CodeBlock
          title="Verification summary"
          code={JSON.stringify(
            { verdict: "passed", checks: 14, failed: 0, harness: "brokkr" },
            null,
            2,
          )}
        />
        <div className="flex flex-col gap-3">
          <Disclosure title="Why is this run waiting?">
            The checks passed, so a person must review the change before it is delivered.
          </Disclosure>
          <Disclosure title="Raw event">
            <span className="font-mono text-xs break-all">{`{"type":"execution.status","status":"verified_pending_review"}`}</span>
          </Disclosure>
        </div>
      </CardGroup>
    </div>
  );
}

function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  useCommandShortcut(() => setPalette(true));
  return (
    <Card title="Dialogs, drawers and hints">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Cancel run…
        </Button>
        <Button onClick={() => setDrawer(true)}>Open inspector</Button>
        <Button icon="search" onClick={() => setPalette(true)}>
          Jump to…{" "}
          <kbd className="ml-1 rounded-sm border border-line px-1 text-xs text-muted">⌘K</kbd>
        </Button>
        <Tooltip content="Tooltips open on hover and on keyboard focus.">
          <Button variant="ghost">Hover or focus me</Button>
        </Tooltip>
        <span className="flex items-center gap-1 text-sm">
          What is a quality gate? <InfoHint term="Quality gate" />
        </span>
      </div>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Request changes"
        description="The implementer gets your note and reworks the change."
        footer={
          <>
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setDialog(false)}>
              Send request
            </Button>
          </>
        }
      >
        <Field label="What should change?">
          <Textarea placeholder="Keep the old rounding for invoices before 2026." />
        </Field>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancel this run?"
        description="Agents stop and unfinished tasks are marked cancelled. This cannot be undone."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        onConfirm={() => setConfirm(false)}
      />
      <Drawer
        open={drawer}
        onOpenChange={setDrawer}
        title="Task: Verify the change"
        description="demo-app · Add greeting endpoint"
      >
        <KeyValue
          items={[
            { label: "Status", value: <StatusPill app="mimir" value="verifying" /> },
            { label: "Crew", value: "Review crew" },
            { label: "Agent", value: <Badge>reviewer</Badge> },
          ]}
        />
      </Drawer>
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        items={[
          { id: "o", label: "Overview", group: "Pages", icon: "apps", run: () => undefined },
          { id: "r", label: "Runs", group: "Pages", icon: "arrowRight", run: () => undefined },
          { id: "s", label: "Settings", group: "Global", icon: "settings", run: () => undefined },
          ...runs.map((r) => ({
            id: r.id,
            label: r.name,
            group: "Runs",
            description: "demo-app",
            run: () => undefined,
          })),
        ]}
      />
    </Card>
  );
}

const docsMarkdown = `# Runs

A **run** executes an approved plan. Mimir works through the tasks with a crew of agents, and Brokkr checks the result.

## Statuses

| Status | Meaning |
|---|---|
| Running | Work is happening now. |
| Awaiting review | Checks passed; a person must review. |
| Failed | Ended with an error. |

## What you can do

- Open a run to see its tasks and evidence.
- Use *Request changes* to send it back with a note.
- Read [Quality gates](/docs/quality-gates) for what is checked.

\`\`\`
sindri run status <run-id>
\`\`\`
`;

function DocsAndGuide() {
  return (
    <div className="flex flex-col gap-group">
      <Card>
        <DocsView
          activeSlug="runs"
          hrefFor={(slug) => `#docs-${slug}`}
          markdown={docsMarkdown}
          sections={[
            {
              title: "Start here",
              pages: [
                { slug: "how", title: "How the factory works" },
                { slug: "lifecycle", title: "Lifecycle of a piece of work" },
              ],
            },
            {
              title: "Sindri",
              pages: [
                { slug: "runs", title: "Runs" },
                { slug: "reviews", title: "Reviews" },
                { slug: "autonomy", title: "Autonomy" },
              ],
            },
            {
              title: "Reference",
              pages: [
                { slug: "glossary", title: "Glossary" },
                { slug: "troubleshooting", title: "Troubleshooting" },
              ],
            },
          ]}
        />
      </Card>
      <Card>
        <GuideChat
          context={{ app: "heimdall", screen: "overview", projectId: "p1" }}
          suggestions={[
            "Why is a run awaiting review?",
            "What does the steward want me to decide?",
            "What does Leased mean?",
          ]}
          ask={async (q) => {
            await new Promise((r) => setTimeout(r, 700));
            return {
              answer: `**${q}**\n\nOne run, *Fix invoice rounding*, passed its checks and now needs a person to review it before delivery. Open it from **Runs** and choose Approve or Request changes.`,
              links: [
                { label: "Open run", href: "#run" },
                { label: "Read: Reviews", href: "#docs-reviews" },
              ],
            };
          }}
        />
      </Card>
    </div>
  );
}

function SplitAndSticky() {
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-group">
      <SplitView
        showDetail={sel != null}
        onBack={() => setSel(null)}
        list={
          <Card title="Specs" count={3} flush>
            <RecordList label="Specs">
              {["Greeting endpoint", "Invoice rounding", "Search ranking"].map((t, i) => (
                <RecordRow
                  key={t}
                  title={t}
                  meta={`v${i + 1} · demo-app`}
                  status={<StatusPill app="sindri" value={["approved", "review", "draft"][i]} />}
                  onClick={() => setSel(t)}
                  selected={sel === t}
                />
              ))}
            </RecordList>
          </Card>
        }
        detail={
          sel ? (
            <Card title={sel} description="Spec detail opens here; on phones it replaces the list.">
              <Tabs
                label="Spec sections"
                items={[
                  {
                    value: "summary",
                    label: "Summary",
                    content: (
                      <p className="text-sm text-muted">Goals, scope and acceptance criteria.</p>
                    ),
                  },
                  {
                    value: "questions",
                    label: "Open questions",
                    count: 2,
                    content: <p className="text-sm text-muted">Two questions block approval.</p>,
                  },
                  {
                    value: "history",
                    label: "History",
                    content: <p className="text-sm text-muted">Three versions.</p>,
                  },
                ]}
              />
            </Card>
          ) : (
            <Card>
              <EmptyState
                compact
                title="Choose a spec"
                body="Pick one from the list, or open the most recent."
                action={
                  <Button size="sm" onClick={() => setSel("Greeting endpoint")}>
                    Open the most recent
                  </Button>
                }
              />
            </Card>
          )
        }
      />
      <StickyActionBar status="2 unsaved changes">
        <Button variant="ghost">Discard</Button>
        <Button variant="primary">Save profile</Button>
      </StickyActionBar>
    </div>
  );
}

function Catalog() {
  const [project, setProject] = useState<string | null>("p1");
  const [operator, setOperator] = useState(false);
  const [code, setCode] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const projectName = projects.find((p) => p.id === project)?.name ?? null;
  return (
    <AppShell
      appName="Heimdall"
      pageTitle="Component catalog"
      apps={[
        {
          id: "sindri",
          label: "Sindri",
          href: "#sindri",
          description: "Plan: intake, specs, plans, runs",
        },
        {
          id: "mimir",
          label: "Mimir",
          href: "#mimir",
          description: "Execute: missions, crews, agents",
        },
        {
          id: "heimdall",
          label: "Heimdall",
          href: "#heimdall",
          description: "Watch: the whole factory",
        },
        {
          id: "skidbladnir",
          label: "Skidbladnir",
          href: "#skidbladnir",
          description: "Workers: the fleet",
        },
      ]}
      currentApp="heimdall"
      projects={projects}
      projectId={project}
      onProjectChange={setProject}
      recentProjectIds={["p1", "p2"]}
      allowAllProjects
      onManageProjects={() => undefined}
      tabs={[
        { id: "overview", label: "Overview", href: "#overview", group: "watch" },
        { id: "pipeline", label: "Pipeline", href: "#pipeline", group: "watch" },
        { id: "crews", label: "Crews & agents", href: "#crews", group: "watch" },
        { id: "activity", label: "Activity", href: "#activity", group: "watch" },
        {
          id: "quality",
          label: "Quality & approvals",
          href: "#quality",
          group: "decide",
          count: 2,
        },
        { id: "autonomy", label: "Autonomy", href: "#autonomy", group: "decide" },
      ]}
      activeTabId="overview"
      primaryAction={
        <Button variant="primary" size="sm" icon="plus">
          New work
        </Button>
      }
      connection={{
        state: "live",
        detail: "Local · 127.0.0.1:4320 · last event 2 s ago",
        onReconnect: () => undefined,
      }}
      session={{
        mode: operator ? "operator" : "read-only",
        content: operator ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">Operator controls are unlocked for this session.</p>
            <Button size="sm" icon="lock" onClick={() => setOperator(false)}>
              Lock again
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setOperator(code.length > 0);
            }}
          >
            <p className="text-sm font-semibold">Unlock operator controls</p>
            <Field label="Operator code" hint="Shown in the terminal where Heimdall started.">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
              />
            </Field>
            <Button type="submit" variant="primary" size="sm">
              Unlock
            </Button>
          </form>
        ),
      }}
      globalLinks={[
        { id: "projects", label: "Projects", href: "#projects", icon: "folder" },
        { id: "connections", label: "Connections", href: "#connections", icon: "refresh" },
        { id: "fleet", label: "Fleet", href: "#fleet", icon: "apps" },
        { id: "autonomy-all", label: "Autonomy (all)", href: "#autonomy-all", icon: "info" },
        { id: "settings", label: "Settings", href: "#settings", icon: "settings" },
      ]}
      docsHref="#docs"
      onAsk={() => setAskOpen(true)}
      onShortcuts={() => undefined}
      onSignOut={() => undefined}
    >
      <GlossaryProvider
        entries={glossary}
        docsHref={(t) => `#docs-${t.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <Page>
          <PageHeader
            title="Component catalog"
            description="Every @factory/ui component with illustrative data. Use it to review spacing, states and both themes."
            info="This page is for development; it is not shown to operators."
            scope={{ project: projectName }}
            meta={<Timestamp value={ago(1)} now={NOW} prefix="Updated" />}
            actions={
              <>
                <Button icon="refresh">Refresh</Button>
                <Button variant="primary" icon="plus">
                  New work
                </Button>
              </>
            }
          />
          <Section
            title="Status roles"
            description="Eight roles cover every status in the four apps. Unknown values keep their raw text."
          >
            <Swatches />
            <Card
              title="Status pills by app"
              description="Human label, coloured dot; hover or focus for the meaning and the raw value."
            >
              <div className="flex flex-col gap-4">
                {Object.entries(samples).map(([app, values]) => (
                  <div key={app} className="grid gap-2 sm:grid-cols-[120px_1fr] sm:items-center">
                    <span className="text-sm font-medium capitalize text-muted">{app}</span>
                    <div className="flex flex-wrap gap-2">
                      {values.map((v) => (
                        <StatusPill key={v} app={app as "sindri"} value={v} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </Section>
          <Section title="Foundations" description="Type scale and the 4px spacing scale.">
            <TypeAndSpace />
          </Section>
          <Section title="Actions">
            <Actions />
          </Section>
          <Section
            title="Forms"
            description="Every control is 40px tall and shares one focus ring."
          >
            <Forms />
          </Section>
          <Section
            title="Tables"
            description="Padded cells, sticky header, numbers right-aligned. On phones each row becomes a labelled card."
            actions={
              <Toolbar label="Table filters">
                <Input
                  prefix="search"
                  placeholder="Filter runs…"
                  className="w-56"
                  aria-label="Filter runs"
                />
              </Toolbar>
            }
          >
            <Data />
          </Section>
          <Section title="Feedback" description="Empty, error, loading and notices.">
            <Feedback />
          </Section>
          <Section title="Records, time and evidence">
            <Records />
          </Section>
          <Section title="Overlays">
            <Overlays />
          </Section>
          <Section
            title="List and detail"
            description="SplitView with tabs and a sticky action bar."
          >
            <SplitAndSticky />
          </Section>
          <Section
            title="Docs and guide"
            description="DocsView renders the shared docs; GuideChat is read-only and cites links."
          >
            <DocsAndGuide />
          </Section>
        </Page>
        <Drawer open={askOpen} onOpenChange={setAskOpen} title="Guide">
          <GuideChat
            title="Ask the guide"
            context={{ app: "heimdall" }}
            suggestions={["What does Awaiting review mean?"]}
            ask={async () => ({
              answer: "It means the checks passed and a person must review.",
              links: [],
            })}
          />
        </Drawer>
      </GlossaryProvider>
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Catalog />
  </StrictMode>,
);
