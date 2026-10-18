import { useState, type FormEvent } from "react";
import { describeError } from "../api/client.js";
import { ActionResult, type ActionOutcome } from "../components/ActionResult.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { useStore } from "../store/StoreProvider.js";

function ProjectForm() {
  const { client, refresh } = useStore();
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
      setOutcome({ kind: "error", error: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-2">
      <label className="grid gap-1">
        <span className="font-medium">Name</span>
        <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Repository path</span>
        <input
          className="input font-mono"
          required
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Test command</span>
        <input
          className="input font-mono"
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Protected branches (comma separated)</span>
        <input
          className="input font-mono"
          value={branches}
          onChange={(e) => setBranches(e.target.value)}
        />
      </label>
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Create project
        </button>
      </div>
      <ActionResult outcome={outcome} />
    </form>
  );
}

export function Projects() {
  const { state } = useStore();
  return (
    <>
      <PageTitle>Projects</PageTitle>
      <StoreGate label="projects">
        <Section title="All projects">
          {state.projects.length === 0 ? (
            <EmptyState>No projects yet. Create one below.</EmptyState>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Test command</th>
                  <th scope="col">Protected branches</th>
                </tr>
              </thead>
              <tbody>
                {state.projects.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td>{p.name}</td>
                    <td className="font-mono">{p.repoPath}</td>
                    <td className="font-mono">
                      {Array.isArray(p.settings["testCommand"])
                        ? (p.settings["testCommand"] as string[]).join(" ")
                        : typeof p.settings["testCommand"] === "string"
                          ? p.settings["testCommand"]
                          : "—"}
                    </td>
                    <td className="font-mono">
                      {Array.isArray(p.settings["protectedBranches"])
                        ? (p.settings["protectedBranches"] as string[]).join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title="Create project">
          <ProjectForm />
        </Section>
      </StoreGate>
    </>
  );
}
