import { useEffect, useState } from "react";
import type { BootstrapResult, SearchHit } from "../api/types.js";
import { Badge, Button, Card, Empty, Field, inputClass } from "../components/ui.js";
import { useApi, useReportError, useStore } from "../store/context.js";

export function ProjectsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [boot, setBoot] = useState<{ projectId: string; result: BootstrapResult } | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    api.listProjects().then(
      (projects) => {
        dispatch({ type: "projects/loaded", projects });
        setLoading(false);
      },
      (e: unknown) => {
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoading(false);
        report(e);
      },
    );
  };
  useEffect(load, []);

  const create = async () => {
    setBusy("create");
    try {
      const project = await api.createProject({ name: name.trim(), repoPath: repoPath.trim() });
      dispatch({ type: "projects/upsert", project });
      dispatch({ type: "project/select", projectId: project.id });
      dispatch({
        type: "notice",
        notice: { kind: "info", text: `Created project ${project.name}` },
      });
      setName("");
      setRepoPath("");
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
    }
  };

  const bootstrap = async (projectId: string) => {
    setBusy(`boot:${projectId}`);
    try {
      const result = await api.bootstrap(projectId);
      setBoot({ projectId, result });
      dispatch({
        type: "notice",
        notice: {
          kind: "info",
          text: `Bootstrap finished: ${result.indexed.length} files indexed`,
        },
      });
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
    }
  };

  const search = async () => {
    if (!state.projectId || !q.trim()) return;
    setBusy("search");
    try {
      setHits(await api.search(state.projectId, q.trim()));
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Projects">
        {loading ? (
          <p role="status">Loading projects…</p>
        ) : loadError ? (
          <div className="space-y-2 text-sm">
            <p>Could not load projects: {loadError}</p>
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          </div>
        ) : state.projects.length === 0 ? (
          <Empty>No projects yet. Create one below with the path to a local repository.</Empty>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {state.projects.map((p) => (
              <li key={p.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {p.name} {state.projectId === p.id ? <Badge tone="ok">selected</Badge> : null}
                    </p>
                    <p className="font-mono text-xs text-slate-600 dark:text-slate-300">
                      {p.repoPath}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {state.projectId !== p.id ? (
                      <Button
                        variant="secondary"
                        onClick={() => dispatch({ type: "project/select", projectId: p.id })}
                      >
                        Select <span className="sr-only">{p.name}</span>
                      </Button>
                    ) : null}
                    <Button onClick={() => void bootstrap(p.id)} disabled={busy !== null}>
                      {busy === `boot:${p.id}` ? "Bootstrapping…" : "Bootstrap"}{" "}
                      <span className="sr-only">{p.name}</span>
                    </Button>
                  </div>
                </div>
                {boot?.projectId === p.id ? <BootstrapSummary result={boot.result} /> : null}
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700"
          aria-label="Create project"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h3 className="font-semibold">Create project</h3>
          <Field label="Name" id="project-name">
            <input
              id="project-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Repository path"
            id="project-repo"
            hint="Absolute path to a local checkout."
          >
            <input
              id="project-repo"
              aria-describedby="project-repo-hint"
              className={`${inputClass} font-mono`}
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!name.trim() || !repoPath.trim() || busy !== null}>
            Create project
          </Button>
        </form>
      </Card>

      <Card title="Search project knowledge">
        {!state.projectId ? (
          <Empty>Select a project to search its index.</Empty>
        ) : (
          <>
            <form
              role="search"
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <label htmlFor="project-search" className="sr-only">
                Search the project index
              </label>
              <input
                id="project-search"
                type="search"
                className={inputClass}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search docs, ADRs, manifests…"
              />
              <Button type="submit" disabled={!q.trim() || busy !== null}>
                Search
              </Button>
            </form>
            {hits === null ? null : hits.length === 0 ? (
              <Empty>No matches. Bootstrap the project first if you have not.</Empty>
            ) : (
              <ol className="space-y-2" aria-label="Search results">
                {hits.map((h) => (
                  <li
                    key={h.chunkId}
                    className="rounded border border-slate-200 p-2 dark:border-slate-700"
                  >
                    <p className="font-mono text-xs">
                      {h.path}#L{h.startLine}-L{h.endLine} <Badge>{h.kind}</Badge>
                    </p>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                      {h.text}
                    </pre>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function BootstrapSummary({ result }: { result: BootstrapResult }) {
  return (
    <div
      className="rounded bg-slate-100 p-2 text-sm dark:bg-slate-800"
      aria-label="Bootstrap result"
    >
      <p>
        Indexed {result.indexed.length}, unchanged {result.unchanged.length}, removed{" "}
        {result.removed.length}, skipped {result.skipped.length}.
      </p>
      {result.skipped.length > 0 ? (
        <details>
          <summary className="cursor-pointer">Skipped files</summary>
          <ul className="font-mono text-xs">
            {result.skipped.map((s) => (
              <li key={s.path}>
                {s.path} ({s.reason})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
