// New work: register a project with Sindri, describe the work, then follow its specifications and
// plans. Also the plan and specification editors the inspector shows. Sindri validates everything.
import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  Card,
  CardGroup,
  Cluster,
  Disclosure,
  EmptyState,
  Field,
  Grid,
  GridItem,
  Input,
  Page,
  PageHeader,
  RecordList,
  RecordRow,
  Select,
  Stack,
  Stepper,
  Textarea,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore, Status } from "../components/app";
import type { R } from "../lib/api";
import { AccessCallout } from "./AccessCallout";
import {
  actionBlock,
  latestVersions,
  sameRepo,
  specRevision,
  statusBadge,
} from "./workflowState";

const STEPS = [
  { id: "connect", label: "Connect a project" },
  { id: "describe", label: "Describe the work" },
  { id: "review", label: "Review, plan, execute" },
];
const LISTS = [
  {
    kind: "intakes",
    title: "Intakes",
    term: "Intake",
    domain: "intake",
    empty: "No intakes yet.",
  },
  {
    kind: "specs",
    title: "Specifications",
    term: "Spec",
    domain: "spec",
    empty: "No specifications yet.",
  },
  {
    kind: "plans",
    title: "Plans",
    term: "Plan",
    domain: "plan",
    empty: "No plans yet.",
  },
] as const;

/** Top-bar page: new work for the selected project (or any active one under All projects). */
export function NewWorkPage() {
  const { state, scope, session, propose, open, projectName } = useHeimdall();
  const [name, setName] = useState(""),
    [repo, setRepo] = useState(""),
    [project, setProject] = useState(""),
    [request, setRequest] = useState(""),
    [title, setTitle] = useState("");
  const sindri: R = state?.sindri ?? {};
  // Sindri's records of the active (not archived) projects; one repository may be registered twice.
  const projects = scope.sindriProjects.filter((p) =>
    scope.activeProjects.some(
      (a) => a.id === p.id || sameRepo(a.repoPath, p.repoPath),
    ),
  );
  const preferred = projects.find(
    (p) => scope.filter !== "all" && scope.sindriIds.has(p.id),
  )?.id;
  const ids = projects.map((p) => p.id).join(",");
  // Follow the picker; keep a manual choice while it is still a valid project.
  useEffect(() => {
    setProject(
      (old) =>
        preferred ??
        (projects.some((p) => p.id === old) ? old : (projects[0]?.id ?? "")),
    );
  }, [preferred, ids]);

  const access = actionBlock("project.create", undefined, session);
  const noProject = project ? "" : "Choose a project first.";
  const createWhy =
    access ||
    (!name.trim()
      ? "Enter the project name first."
      : !repo.startsWith("/")
        ? "Enter an absolute repository path (it starts with /)."
        : "");
  const bootstrapWhy = access || noProject;
  const intakeWhy =
    access ||
    noProject ||
    (!title.trim()
      ? "Enter the intake title first."
      : !request.trim()
        ? "Describe the request first."
        : "");
  const draftWhy =
    access ||
    noProject ||
    (request.trim() ? "" : "Describe the request first.");
  const recordsOf = (kind: string): R[] =>
    (kind === "intakes"
      ? (sindri[kind] ?? [])
      : latestVersions(sindri[kind] ?? [])
    ).filter((r: R) => !project || r.projectId === project);
  const started = LISTS.some((l) => recordsOf(l.kind).length > 0);
  const step = !projects.length ? 0 : started ? 2 : 1;

  return (
    <Page>
      <PageHeader
        title="New work"
        description={
          <>
            Connect a local repository, describe what to build, then review the
            specification and plan before anything runs.
          </>
        }
        learnMore={<LearnMore screen="new-work" />}
        scope={{ project: projectName }}
      />
      <AccessCallout pairing>
        Unlock operator controls and pair Sindri to create or run work.
      </AccessCallout>
      <Stepper steps={STEPS} current={step} />
      <CardGroup min={340}>
        <Card
          title="Connect a project"
          term="Project"
          description="Register an existing local Git repository with Sindri. No remote repository is required."
        >
          <Stack gap={4}>
            <Field label="Project name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Absolute repository path">
              <Input
                placeholder="/Users/you/Projects/my-app"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </Field>
            <Cluster>
              <Button
                variant="primary"
                disabledReason={createWhy || undefined}
                onClick={() =>
                  propose("project.create", "new", { name, repoPath: repo })
                }
              >
                Review project creation
              </Button>
            </Cluster>
          </Stack>
        </Card>
        <Card title="Describe the work" term="Intake">
          <Stack gap={4}>
            <Field label="Project" term="Project">
              <Select
                value={project}
                onValueChange={setProject}
                options={[
                  { value: "", label: "Choose a project" },
                  ...projects.map((p) => ({
                    value: p.id,
                    label: p.name ?? p.id,
                  })),
                ]}
              />
            </Field>
            <Cluster>
              <Button
                disabledReason={bootstrapWhy || undefined}
                onClick={() => propose("project.bootstrap", project)}
              >
                Read project context
              </Button>
            </Cluster>
            <Field label="Intake title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field
              label="Request"
              hint="Drafting calls your configured model. You review and approve the specification and plan before execution."
            >
              <Textarea
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="What should we build? Include outcomes, constraints, and how we can verify success."
              />
            </Field>
            <Cluster gap={2}>
              <Button
                disabledReason={intakeWhy || undefined}
                onClick={() =>
                  propose("intake.create", "new", {
                    projectId: project,
                    title,
                    body: request,
                  })
                }
              >
                Save intake
              </Button>
              <Button
                variant="primary"
                disabledReason={draftWhy || undefined}
                onClick={() =>
                  propose("spec.draft", "new", { projectId: project, request })
                }
              >
                Draft specification
              </Button>
            </Cluster>
          </Stack>
        </Card>
      </CardGroup>
      <Card
        title="Review, plan, execute"
        description="Open a specification to answer questions or revise it, submit it for review and approve it. Propose a plan, adjust priorities and budgets, approve the revision, then start the run."
      >
        <CardGroup min={280}>
          {LISTS.map((list) => {
            const records = recordsOf(list.kind);
            return (
              <Card
                key={list.kind}
                title={list.title}
                term={list.term}
                count={records.length}
                headingLevel={3}
                flush
              >
                {records.length ? (
                  <RecordList label={list.title}>
                    {records.map((r) => (
                      <RecordRow
                        key={r.id}
                        title={r.title ?? `Plan v${r.version}`}
                        meta={`${list.kind === "specs" && r.version != null ? `v${r.version} · ` : ""}${r.id}`}
                        status={
                          statusBadge(list.kind, r) && (
                            <Status
                              value={statusBadge(list.kind, r)}
                              domain={list.domain}
                              size="sm"
                              tooltip={false}
                            />
                          )
                        }
                        onClick={() => open(list.kind, r)}
                      />
                    ))}
                  </RecordList>
                ) : (
                  <EmptyState
                    compact
                    className="m-4"
                    title={list.empty}
                    body={
                      list.kind === "plans"
                        ? "Approve a specification, then propose a plan from it."
                        : "Describe the work above to start one."
                    }
                  />
                )}
              </Card>
            );
          })}
        </CardGroup>
      </Card>
    </Page>
  );
}

const taskNumber = (
  label: string,
  value: unknown,
  set: (n: number) => void,
  attrs: R = {},
) => (
  <Field label={label}>
    <Input
      type="number"
      value={value as string | number}
      onChange={(e) => set(Number(e.target.value))}
      {...attrs}
    />
  </Field>
);

/** Inspector editor for a plan's tasks; saving proposes a new draft revision. */
export function PlanEditor({ plan }: { plan: R }) {
  const { session, propose } = useHeimdall();
  const [tasks, setTasks] = useState<R[]>(() => structuredClone(plan.tasks)),
    [error, setError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    setTasks(structuredClone(plan.tasks));
    setDrafts({});
  }, [plan.id]);
  const why = actionBlock("plan.revise", undefined, session);
  const draftValue = (t: R, key: string, separator: string) =>
    drafts[t.id]?.[key] ?? (t[key] ?? []).join(separator);
  const editList = (id: string, key: string, value: string) =>
    setDrafts((old) => ({ ...old, [id]: { ...old[id], [key]: value } }));
  const update = (i: number, key: string, value: unknown) =>
    setTasks((rows) =>
      rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)),
    );
  // Optional budgets: an empty field removes the key rather than saving 0.
  const optionalBudget = (i: number, t: R, key: string, raw: string) => {
    const b = { ...t.budget };
    if (raw) b[key] = Number(raw);
    else delete b[key];
    update(i, "budget", b);
  };
  return (
    <Disclosure title="Edit task priorities, dependencies and budgets">
      <Stack gap={4}>
        <p className="text-sm text-muted">
          Saving creates a new draft plan. Existing executions are unchanged.
          Priority changes are applied by Sindri when dispatching a newly
          approved plan; dependencies always take precedence.
        </p>
        <Callout tone="warning">
          Every task is saved exactly as shown here, including the ones you do
          not edit. Text is cleaned for display before it reaches this editor,
          so angle-bracket tags or very long text in the original plan may
          already be removed or shortened. Check each task before saving.
        </Callout>
        {tasks.map((t, i) => (
          <fieldset
            key={t.id}
            className="flex min-w-0 flex-col gap-4 rounded-md border border-line p-4"
          >
            <legend className="px-1 font-mono text-sm break-all">{t.id}</legend>
            <Field label="Objective">
              <Textarea
                value={t.objective}
                onChange={(e) => update(i, "objective", e.target.value)}
              />
            </Field>
            <Grid gap={4}>
              <GridItem span={4}>
                {taskNumber(
                  "Priority (higher first)",
                  t.priority ?? 0,
                  (n) => update(i, "priority", n),
                  {
                    min: "0",
                    max: "100",
                  },
                )}
              </GridItem>
              <GridItem span={4}>
                {taskNumber(
                  "Time limit (minutes)",
                  t.budget.wallClockMinutes,
                  (n) =>
                    update(i, "budget", { ...t.budget, wallClockMinutes: n }),
                  { min: "1" },
                )}
              </GridItem>
              <GridItem span={4}>
                {taskNumber(
                  "Maximum retries",
                  t.maxRetries,
                  (n) => update(i, "maxRetries", n),
                  {
                    min: "0",
                    max: "3",
                  },
                )}
              </GridItem>
              <GridItem span={6}>
                <Field label="Token budget" term="Task budget">
                  <Input
                    type="number"
                    min="1"
                    value={t.budget.tokens ?? ""}
                    onChange={(e) =>
                      optionalBudget(i, t, "tokens", e.target.value)
                    }
                  />
                </Field>
              </GridItem>
              <GridItem span={6}>
                <Field label="Cost budget (USD)">
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={t.budget.costUsd ?? ""}
                    onChange={(e) =>
                      optionalBudget(i, t, "costUsd", e.target.value)
                    }
                  />
                </Field>
              </GridItem>
            </Grid>
            <Field label="Dependencies (comma separated IDs)">
              <Input
                value={draftValue(t, "dependsOn", ", ")}
                onChange={(e) => editList(t.id, "dependsOn", e.target.value)}
              />
            </Field>
            {["inputs", "outputs", "acceptanceCriteria"].map((key) => (
              <Field
                key={key}
                label={
                  key === "acceptanceCriteria"
                    ? "Acceptance criterion IDs (one per line)"
                    : key + " (one per line)"
                }
              >
                <Textarea
                  value={draftValue(t, key, "\n")}
                  onChange={(e) => editList(t.id, key, e.target.value)}
                />
              </Field>
            ))}
          </fieldset>
        ))}
        {error && <Callout tone="danger">{error}</Callout>}
        <Cluster>
          <Button
            variant="primary"
            disabledReason={why || undefined}
            onClick={() => {
              setError("");
              if (
                tasks.some(
                  (t) =>
                    !Number.isInteger(t.priority ?? 0) ||
                    t.priority < 0 ||
                    t.priority > 100,
                )
              ) {
                setError("Priorities must be whole numbers from 0 to 100.");
                return;
              }
              const revised = tasks.map((t) => ({
                ...t,
                ...Object.fromEntries(
                  Object.entries(drafts[t.id] ?? {}).map(([key, value]) => [
                    key,
                    value
                      .split(key === "dependsOn" ? "," : "\n")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  ]),
                ),
              }));
              propose("plan.revise", plan.id, { tasks: revised });
            }}
          >
            Review new plan revision
          </Button>
        </Cluster>
      </Stack>
    </Disclosure>
  );
}

/** Inspector editor for a specification; only the changed fields are sent. */
export function SpecEditor({ spec }: { spec: R }) {
  const { session, propose } = useHeimdall();
  const [title, setTitle] = useState(spec.title),
    [problem, setProblem] = useState(spec.body.problem),
    [goals, setGoals] = useState((spec.body.goals ?? []).join("\n"));
  // Unchanged fields stay out of the request: their text here is a display copy, not the stored one.
  const revision = specRevision(spec, { title, problem, goals });
  const why =
    actionBlock("spec.revise", undefined, session) ||
    (!title.trim() || !problem.trim()
      ? "The title and problem cannot be empty."
      : revision
        ? ""
        : "Change the title, problem or goals first.");
  return (
    <Disclosure title="Request changes / revise specification">
      <Stack gap={4}>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Problem">
          <Textarea
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
          />
        </Field>
        <Field label="Goals (one per line)">
          <Textarea value={goals} onChange={(e) => setGoals(e.target.value)} />
        </Field>
        <Cluster gap={3}>
          <Button
            variant="primary"
            disabledReason={why || undefined}
            onClick={() =>
              revision && propose("spec.revise", spec.id, revision)
            }
          >
            Review new specification revision
          </Button>
        </Cluster>
        <p className="text-sm text-muted">
          {revision
            ? "Only the fields you changed are sent; everything else keeps its stored text."
            : "Change the title, problem or goals to create a revision."}
        </p>
      </Stack>
    </Disclosure>
  );
}
