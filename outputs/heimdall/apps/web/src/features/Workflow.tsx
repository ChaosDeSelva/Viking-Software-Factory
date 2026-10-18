import {
  Card,
  Field,
  Input,
  Button,
  Select,
  Option,
  Textarea,
  Disclosure,
  DisclosureTrigger,
} from "../components/ui";
import { useEffect, useState } from "react";
type R = Record<string, any>;
type Propose = (action: string, id: string, body?: R, extra?: R) => void;
export function Workbench({
  data,
  enabled,
  propose,
  inspect,
}: {
  data: R;
  enabled: boolean;
  propose: Propose;
  inspect: (kind: string, row: R) => void;
}) {
  const [name, setName] = useState(""),
    [repo, setRepo] = useState(""),
    [project, setProject] = useState(""),
    [request, setRequest] = useState(""),
    [title, setTitle] = useState("");
  const projects = data.projects ?? [];
  useEffect(() => {
    if (!projects.some((p: R) => p.id === project)) setProject(projects[0]?.id ?? "");
  }, [projects, project]);
  return (
    <div className="connection-grid workflow-grid">
      <Card className="panel">
        <h2>1 · Connect a local project</h2>
        <p className="muted">
          Register an existing local Git repository with Sindri. No remote
          repository is required.
        </p>
        <Field>
          Project name
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field>
          Absolute repository path
          <Input
            placeholder="/Users/you/Projects/my-app"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </Field>
        <Button
          disabled={!enabled || !name.trim() || !repo.startsWith("/")}
          onClick={() =>
            propose("project.create", "new", { name, repoPath: repo })
          }
        >
          Review project creation
        </Button>
      </Card>
      <Card className="panel">
        <h2>2 · Describe the work</h2>
        <Field>
          Project
          <Select value={project} onValueChange={(value) => setProject(value)}>
            <Option value="">Choose a project</Option>
            {projects.map((p: R) => (
              <Option key={p.id} value={p.id}>
                {p.name}
              </Option>
            ))}
          </Select>
        </Field>
        <div className="actions">
          <Button
            disabled={!enabled || !project}
            onClick={() => propose("project.bootstrap", project)}
          >
            Read project context
          </Button>
        </div>
        <Field>
          Intake title
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field>
          Request
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="What should we build? Include outcomes, constraints, and how we can verify success."
          />
        </Field>
        <div className="actions">
          <Button
            disabled={!enabled || !project || !title.trim() || !request.trim()}
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
            disabled={!enabled || !project || !request.trim()}
            onClick={() =>
              propose("spec.draft", "new", { projectId: project, request })
            }
          >
            Draft specification
          </Button>
        </div>
        <small>
          Drafting calls your configured model. You review and approve the
          specification and plan before execution.
        </small>
      </Card>
      <Card className="panel wide">
        <h2>3 · Review, plan, execute</h2>
        <p className="muted">
          Open a specification to answer questions or revise it, submit it for
          review and approve it. Propose a plan, adjust priorities and budgets,
          approve the revision, then start the run.
        </p>
        {["intakes", "specs", "plans"].map((kind) => (
          <div key={kind}>
            <h3>{kind}</h3>
            {(data[kind] ?? [])
              .filter((r: R) => !project || r.projectId === project)
              .map((r: R) => (
                <Button
                  variant="unstyled"
                  className="row"
                  key={r.id}
                  onClick={() => inspect(kind, r)}
                >
                  <span>
                    {r.title ?? `Plan v${r.version}`}
                    <small>{r.id}</small>
                  </span>
                  <span className="badge">{r.status ?? "intake"}</span>
                </Button>
              ))}
          </div>
        ))}
      </Card>
    </div>
  );
}
export function PlanEditor({
  plan,
  enabled,
  propose,
}: {
  plan: R;
  enabled: boolean;
  propose: Propose;
}) {
  const [tasks, setTasks] = useState<R[]>(() => structuredClone(plan.tasks)),
    [error, setError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    setTasks(structuredClone(plan.tasks));
    setDrafts({});
  }, [plan.id]);
  const draftValue = (t: R, key: string, separator: string) =>
    drafts[t.id]?.[key] ?? (t[key] ?? []).join(separator);
  const editList = (id: string, key: string, value: string) =>
    setDrafts((old) => ({ ...old, [id]: { ...old[id], [key]: value } }));
  const update = (i: number, key: string, value: any) =>
    setTasks((rows) =>
      rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)),
    );
  return (
    <Disclosure className="editor">
      <DisclosureTrigger>
        Edit task priorities, dependencies and budgets
      </DisclosureTrigger>
      <p className="muted">
        Saving creates a new draft plan. Existing executions are unchanged.
        Priority changes are applied by Sindri when dispatching a newly approved
        plan; dependencies always take precedence.
      </p>
      {tasks.map((t, i) => (
        <fieldset key={t.id}>
          <legend>{t.id}</legend>
          <Field>
            Objective
            <Textarea
              value={t.objective}
              onChange={(e) => update(i, "objective", e.target.value)}
            />
          </Field>
          <div className="form-grid">
            <Field>
              Priority (higher first)
              <Input
                type="number"
                min="0"
                max="100"
                value={t.priority ?? 0}
                onChange={(e) => update(i, "priority", Number(e.target.value))}
              />
            </Field>
            <Field>
              Time limit (minutes)
              <Input
                type="number"
                min="1"
                value={t.budget.wallClockMinutes}
                onChange={(e) =>
                  update(i, "budget", {
                    ...t.budget,
                    wallClockMinutes: Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field>
              Token budget
              <Input
                type="number"
                min="1"
                value={t.budget.tokens ?? ""}
                onChange={(e) => {
                  const b = { ...t.budget };
                  if (e.target.value) b.tokens = Number(e.target.value);
                  else delete b.tokens;
                  update(i, "budget", b);
                }}
              />
            </Field>
            <Field>
              Cost budget (USD)
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={t.budget.costUsd ?? ""}
                onChange={(e) => {
                  const b = { ...t.budget };
                  if (e.target.value) b.costUsd = Number(e.target.value);
                  else delete b.costUsd;
                  update(i, "budget", b);
                }}
              />
            </Field>
            <Field>
              Maximum retries
              <Input
                type="number"
                min="0"
                max="3"
                value={t.maxRetries}
                onChange={(e) =>
                  update(i, "maxRetries", Number(e.target.value))
                }
              />
            </Field>
          </div>
          <Field>
            Dependencies (comma separated IDs)
            <Input
              value={draftValue(t, "dependsOn", ", ")}
              onChange={(e) => editList(t.id, "dependsOn", e.target.value)}
            />
          </Field>
          {["inputs", "outputs", "acceptanceCriteria"].map((key) => (
            <Field key={key}>
              {key === "acceptanceCriteria"
                ? "Acceptance criterion IDs (one per line)"
                : key + " (one per line)"}
              <Textarea
                value={draftValue(t, key, "\n")}
                onChange={(e) => editList(t.id, key, e.target.value)}
              />
            </Field>
          ))}
        </fieldset>
      ))}
      {error && <p role="alert">{error}</p>}
      <Button
        disabled={!enabled}
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
    </Disclosure>
  );
}
export function SpecEditor({
  spec,
  enabled,
  propose,
}: {
  spec: R;
  enabled: boolean;
  propose: Propose;
}) {
  const [title, setTitle] = useState(spec.title),
    [problem, setProblem] = useState(spec.body.problem),
    [goals, setGoals] = useState((spec.body.goals ?? []).join("\n"));
  return (
    <Disclosure className="editor">
      <DisclosureTrigger>
        Request changes / revise specification
      </DisclosureTrigger>
      <Field>
        Title
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field>
        Problem
        <Textarea
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
        />
      </Field>
      <Field>
        Goals (one per line)
        <Textarea value={goals} onChange={(e) => setGoals(e.target.value)} />
      </Field>
      <Button
        disabled={!enabled || !title.trim() || !problem.trim()}
        onClick={() =>
          propose("spec.revise", spec.id, {
            title,
            body: { problem, goals: goals.split("\n").filter(Boolean) },
          })
        }
      >
        Review new specification revision
      </Button>
    </Disclosure>
  );
}
