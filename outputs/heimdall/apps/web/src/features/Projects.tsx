// Projects: every project Heimdall knows from Mimir and Sindri, with archive and restore. Archiving
// only hides a project in Heimdall (a preference on this Mac); the sources keep it.
import { useState } from "react";
import {
  Button,
  Card,
  Cluster,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Input,
  Page,
  PageHeader,
  SegmentedControl,
  Toolbar,
  type Column,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore, Status } from "../components/app";
import type { R } from "../lib/api";
import { hrefFor, navigate } from "../lib/router";
import { changeArchive } from "./projectArchive";
import { projectKey } from "./workflowState";

export function ProjectsPage() {
  const { state, scope, setProject, open, notify, savePreferences, href } =
    useHeimdall();
  const [view, setView] = useState("active");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<R | null>(null);
  const [busy, setBusy] = useState(false);
  const archived: string[] = state?.preferences?.archivedProjects ?? [];
  const visible = scope.allProjects.filter(
    (p) =>
      scope.isArchived(p) === (view === "archived") &&
      `${p.name ?? ""} ${p.repoPath ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  async function change(project: R, archive: boolean) {
    setBusy(true);
    try {
      await changeArchive(project, archive, {
        archived,
        sindriProjects: scope.sindriProjects,
        allProjects: scope.allProjects,
        filter: scope.filter,
        save: savePreferences,
        selectAll: () => setProject("all"),
        done: (message) => {
          notify(message, "success");
          setPending(null);
        },
      });
    } catch (e) {
      notify((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<R>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (p) => (
        <span className="break-words">{p.name ?? "Local project"}</span>
      ),
    },
    {
      key: "repo",
      header: "Repository path",
      cell: (p) => (
        <span className="font-mono text-xs break-all">
          {p.repoPath ?? p.id}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => (
        <Status
          value={scope.isArchived(p) ? "archived" : "active"}
          domain="project"
          size="sm"
        />
      ),
    },
    {
      key: "actions",
      header: "Actions",
      cell: (p) =>
        view === "active" ? (
          <Cluster gap={2}>
            <Button
              size="sm"
              onClick={() => {
                const key = projectKey(p);
                setProject(key);
                navigate(hrefFor("overview", { project: key }));
              }}
            >
              Open project
            </Button>
            <Button size="sm" onClick={() => open("projects", p)}>
              Execution profile
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setPending(p)}
            >
              Archive
            </Button>
          </Cluster>
        ) : (
          <Button
            size="sm"
            loading={busy}
            onClick={() => void change(p, false)}
          >
            Restore project
          </Button>
        ),
    },
  ];

  const empty = query ? (
    <EmptyState
      compact
      className="m-4"
      title="No projects match your search."
      action={
        <Button size="sm" onClick={() => setQuery("")}>
          Clear search
        </Button>
      }
    />
  ) : view === "archived" ? (
    <EmptyState
      compact
      className="m-4"
      title="No archived projects."
      body="Archived projects are listed here and can be restored at any time."
    />
  ) : (
    <EmptyState
      compact
      className="m-4"
      title="No active projects."
      body="Register a local repository to begin, or restore an archived project."
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() => navigate(href("new-work"))}
        >
          New project
        </Button>
      }
    />
  );

  return (
    <Page>
      <PageHeader
        title="Projects"
        description={
          <>
            Every project from Mimir and Sindri. Archiving hides a project in
            Heimdall only; files, history and running work are untouched.
          </>
        }
        learnMore={<LearnMore screen="projects" />}
        term="Project"
        scope={{ global: true }}
        actions={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => navigate(href("new-work"))}
          >
            New project
          </Button>
        }
      />
      <Card flush>
        <div className="border-b border-line p-4">
          <Toolbar label="Project filters">
            <SegmentedControl
              label="Project views"
              value={view}
              onValueChange={setView}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
            />
            <Input
              aria-label="Search projects"
              prefix="search"
              placeholder="Search by name or repository path"
              className="min-w-0 sm:w-80"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Toolbar>
        </div>
        <DataTable
          caption={view === "active" ? "Active projects" : "Archived projects"}
          columns={columns}
          rows={visible}
          rowKey={(p) => String(p.id)}
          layout="stack"
          empty={empty}
        />
      </Card>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && !busy && setPending(null)}
        title={`Archive ${pending?.name ?? pending?.id ?? "project"}?`}
        description="The source project remains in Mimir and Sindri. Only its visibility in Heimdall changes."
        confirmLabel="Confirm archive"
        cancelLabel="Keep active"
        busy={busy}
        onConfirm={() => pending && void change(pending, true)}
      />
    </Page>
  );
}
