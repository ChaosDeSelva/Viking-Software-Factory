import type { Project } from "@mimir/protocol";
import { Button, DataTable, Dialog, Field, Id, Input, Timestamp, type Column } from "@factory/ui";
import { useState, type FormEvent } from "react";
import { describeError } from "../api/client.js";
import { ActionResult, type ActionOutcome } from "../components/ActionResult.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { useStore } from "../store/StoreProvider.js";

function ProjectForm() {
  const { client, refresh, reportError } = useStore();
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [branches, setBranches] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setOutcome(null);
    const protectedBranches = branches
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    const settings: Record<string, unknown> = {};
    // The server runs the test command as argv, never through a shell: one word per argument.
    const testArgv = testCommand
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (testArgv.length > 0) settings["testCommand"] = testArgv;
    if (protectedBranches.length > 0) settings["protectedBranches"] = protectedBranches;
    try {
      const res = await client.projects.create({
        name: name.trim(),
        repoPath: repoPath.trim(),
        settings,
      });
      setOutcome({ kind: "ok", message: `Created project ${res.project.name}.` });
      setName("");
      setRepoPath("");
      setTestCommand("");
      setBranches("");
      void refresh();
    } catch (err) {
      reportError(err);
      setOutcome({ kind: "error", error: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form id="project-form" onSubmit={(e) => void submit(e)} className="flex flex-col gap-field">
      <Field label="Name" required>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Repository path"
        required
        hint="Absolute path of the git repository on this machine."
        term="Project"
      >
        <Input
          className="font-mono"
          required
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
        />
      </Field>
      <Field label="Test command" hint="Run as argv without a shell, e.g. pnpm test.">
        <Input
          className="font-mono"
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
        />
      </Field>
      <Field
        label="Protected branches (comma separated)"
        term="Protected branch"
        hint="Agents never commit to these."
      >
        <Input
          className="font-mono"
          value={branches}
          onChange={(e) => setBranches(e.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          Create project
        </Button>
      </div>
      <ActionResult outcome={outcome} />
    </form>
  );
}

const testCommandText = (p: Project) =>
  Array.isArray(p.settings["testCommand"])
    ? (p.settings["testCommand"] as string[]).join(" ")
    : typeof p.settings["testCommand"] === "string"
      ? p.settings["testCommand"]
      : "—";

const branchesText = (p: Project) =>
  Array.isArray(p.settings["protectedBranches"])
    ? (p.settings["protectedBranches"] as string[]).join(", ")
    : "—";

const COLUMNS: readonly Column<Project>[] = [
  {
    key: "name",
    header: "Name",
    primary: true,
    cell: (p) => (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{p.name}</span>
        <Id value={p.id} label="Project ID" />
      </span>
    ),
  },
  {
    key: "repo",
    header: "Repository",
    cell: (p) => <span className="font-mono text-xs break-all">{p.repoPath}</span>,
  },
  {
    key: "test",
    header: "Test command",
    cell: (p) => <span className="font-mono text-xs">{testCommandText(p)}</span>,
  },
  {
    key: "branches",
    header: "Protected branches",
    cell: (p) => <span className="font-mono text-xs">{branchesText(p)}</span>,
  },
  {
    key: "created",
    header: "Created",
    hideOnMobile: true,
    cell: (p) => <Timestamp value={p.createdAt} className="text-sm text-muted" />,
  },
];

export function Projects() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
      New project
    </Button>
  );
  return (
    <Screen
      screen="projects"
      title="Projects"
      term="Project"
      global
      description="Repositories Mimir runs missions in. Pick one in the top bar to scope every page to it."
      actions={newButton}
    >
      <StoreGate label="projects">
        <Section
          title="All projects"
          count={state.projects.length}
          flush={state.projects.length > 0}
        >
          {state.projects.length === 0 ? (
            <EmptyState body="Create one to start missions in its repository." action={newButton}>
              No projects yet
            </EmptyState>
          ) : (
            <DataTable
              caption="Projects"
              columns={COLUMNS}
              rows={state.projects}
              rowKey={(p) => p.id}
            />
          )}
        </Section>
      </StoreGate>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New project"
        description="Register a git repository so missions can run in it."
        size="md"
      >
        <ProjectForm />
      </Dialog>
    </Screen>
  );
}
