import {
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  Input,
  Page,
  Pagination,
  Stack,
  Toolbar,
  type Column,
} from "@factory/ui";
import { useEffect, useMemo, useState } from "react";
import type { BootstrapResult, Project } from "../api/types.js";
import { Badge, Button, Field, inputClass, ScreenHeader, Card } from "../components/ui.js";
import { useApi, useReportError, useStore } from "../store/context.js";

const PAGE_SIZE = 15;

/**
 * Global project management: every registered project (searchable, paged, the selected one
 * first), create, and bootstrap. Per-project settings live on the Project settings tab.
 */
export function ProjectsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [boot, setBoot] = useState<{ project: Project; result: BootstrapResult } | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);

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
  useEffect(() => setPage(1), [filter]);

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

  const bootstrap = async (project: Project) => {
    setBusy(`boot:${project.id}`);
    try {
      const result = await api.bootstrap(project.id);
      setBoot({ project, result });
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

  // The selected project first, then the server's order; the filter matches name or path.
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = state.projects.filter(
      (p) => !f || p.name.toLowerCase().includes(f) || p.repoPath.toLowerCase().includes(f),
    );
    return [
      ...list.filter((p) => p.id === state.projectId),
      ...list.filter((p) => p.id !== state.projectId),
    ];
  }, [state.projects, state.projectId, filter]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const columns: Column<Project>[] = [
    {
      key: "name",
      header: "Project",
      primary: true,
      cell: (p) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 font-medium">
            {p.name}
            {state.projectId === p.id ? <Badge tone="ok">selected</Badge> : null}
          </span>
          <span className="font-mono text-xs break-all text-muted">{p.repoPath}</span>
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      label: "Actions",
      align: "right",
      cell: (p) => (
        <span className="inline-flex justify-end gap-2 whitespace-nowrap">
          {state.projectId !== p.id ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => dispatch({ type: "project/select", projectId: p.id })}
            >
              Select <span className="sr-only">{p.name}</span>
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            loading={busy === `boot:${p.id}`}
            onClick={() => void bootstrap(p)}
            {...(busy !== null && busy !== `boot:${p.id}`
              ? { disabledReason: "Another action is running" }
              : {})}
          >
            {busy === `boot:${p.id}` ? "Bootstrapping…" : "Bootstrap"}{" "}
            <span className="sr-only">{p.name}</span>
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Page>
      <ScreenHeader
        screen="projects"
        title="Projects"
        global
        term="Project"
        description="Every repository Sindri plans for. Select one to work on it; bootstrap indexes its docs so the Director and planner can read them."
        actions={
          <Button variant="secondary" icon="refresh" onClick={load}>
            Refresh
          </Button>
        }
      />
      <div className="grid gap-group lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <Card
          title="All projects"
          count={loading || loadError ? undefined : state.projects.length}
          flush
        >
          {loadError ? (
            <div className="p-card">
              <ErrorState
                title={`Could not load projects: ${loadError}`}
                retryLabel="Retry"
                onRetry={load}
              />
            </div>
          ) : (
            <Stack gap={0}>
              <div className="border-b border-line p-4">
                <Toolbar label="Filter projects">
                  <div className="w-full sm:w-72">
                    <Input
                      type="search"
                      prefix="search"
                      aria-label="Filter projects"
                      placeholder="Filter by name or path"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </div>
                </Toolbar>
              </div>
              <DataTable
                caption="Projects"
                columns={columns}
                rows={shown}
                rowKey={(p) => p.id}
                loading={loading}
                selectedKey={state.projectId ?? undefined}
                layout="stack"
                className="rounded-none border-0"
                empty={
                  state.projects.length === 0 ? (
                    <EmptyState
                      compact
                      icon="folder"
                      title="No projects yet"
                      body="Create one with the path to a local repository."
                    />
                  ) : (
                    <EmptyState
                      compact
                      icon="search"
                      title={`No project matches “${filter.trim()}”`}
                      action={
                        <Button variant="secondary" size="sm" onClick={() => setFilter("")}>
                          Clear the filter
                        </Button>
                      }
                    />
                  )
                }
              />
              {pageCount > 1 ? (
                <div className="border-t border-line p-3">
                  <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
                </div>
              ) : null}
            </Stack>
          )}
        </Card>
        <Stack gap={4}>
          <Card title="Create project" description="Register a local checkout as a project.">
            <form
              className="flex flex-col gap-field"
              aria-label="Create project"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
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
              <div>
                <Button
                  type="submit"
                  {...(!name.trim() || !repoPath.trim()
                    ? { disabledReason: "Enter a name and a repository path" }
                    : busy !== null
                      ? { disabledReason: "Another action is running" }
                      : {})}
                >
                  Create project
                </Button>
              </div>
            </form>
          </Card>
          {boot ? (
            <Card title={`Bootstrap: ${boot.project.name}`} term="Bootstrap">
              <BootstrapSummary result={boot.result} />
            </Card>
          ) : null}
        </Stack>
      </div>
    </Page>
  );
}

export function BootstrapSummary({ result }: { result: BootstrapResult }) {
  return (
    <div className="flex flex-col gap-2 text-sm" aria-label="Bootstrap result">
      <p>
        Indexed {result.indexed.length}, unchanged {result.unchanged.length}, removed{" "}
        {result.removed.length}, skipped {result.skipped.length}.
      </p>
      {result.secretsDropped && result.secretsDropped.length > 0 ? (
        <p>
          {result.secretsDropped.length} passage{result.secretsDropped.length === 1 ? "" : "s"} that
          looked like secrets {result.secretsDropped.length === 1 ? "was" : "were"} left out of the
          index.
        </p>
      ) : null}
      {result.unsafeGitConfig && result.unsafeGitConfig.length > 0 ? (
        <p>
          This repository&apos;s git config has settings that can run code, so git was not used and
          files were listed directly:{" "}
          <span className="font-mono text-xs break-all">{result.unsafeGitConfig.join(", ")}</span>
        </p>
      ) : null}
      {result.skipped.length > 0 ? (
        <Disclosure title="Skipped files">
          <ul className="font-mono text-xs break-all">
            {result.skipped.map((s) => (
              <li key={s.path}>
                {s.path} ({s.reason})
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
