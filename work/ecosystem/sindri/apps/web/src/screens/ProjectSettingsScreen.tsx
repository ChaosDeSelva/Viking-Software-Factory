import { Callout, EmptyState, Page, Stack, Tabs } from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import type { BootstrapResult, Project, SearchHit } from "../api/types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { Badge, Button, Empty, Field, inputClass, ScreenHeader, Card } from "../components/ui.js";
import { useApi, useReportError, useStore } from "../store/context.js";
import { ExecutionProfileCard } from "./ExecutionProfileCard.js";
import { FeedbackGraphCard } from "./FeedbackGraphCard.js";
import { GuidanceCard } from "./GuidanceCard.js";
import { ExplainForm, RepositorySignals } from "./HarnessesScreen.js";
import { BootstrapSummary } from "./ProjectsScreen.js";

/**
 * Everything that configures the selected project: how it is checked (execution profile), its
 * Feedback Graph link, its repository and index, and deleting its data.
 */
export function ProjectSettingsScreen() {
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === state.projectId) ?? null;
  const [tab, setTab] = useState("profile");
  if (!project)
    return (
      <Page>
        <ScreenHeader
          screen="project-settings"
          title="Project settings"
          description="How the selected project is checked, linked and indexed."
        />
        <Card>
          <EmptyState
            icon="folder"
            title="No project selected"
            body="Pick a project in the top bar, or add one."
            action={
              <Button onClick={() => dispatch({ type: "navigate", view: "projects" })}>
                Manage projects
              </Button>
            }
          />
        </Card>
      </Page>
    );
  return (
    <Page>
      <ScreenHeader
        screen="project-settings"
        title="Project settings"
        term="Execution profile"
        description={
          <>
            How <strong className="break-all">{project.name}</strong> is checked, linked to Feedback
            Graph and indexed.
          </>
        }
        meta={<span className="font-mono break-all">{project.repoPath}</span>}
      />
      <Tabs
        label="Project settings"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: "profile",
            label: "Execution profile",
            content: <ExecutionProfileCard key={project.id} project={project} />,
          },
          {
            value: "feedback-graph",
            label: "Feedback Graph",
            content: <FeedbackGraphCard key={project.id} project={project} />,
          },
          {
            value: "guidance",
            label: "Guidance",
            content: <GuidanceCard key={project.id} project={project} />,
          },
          {
            value: "repository",
            label: "Repository & index",
            content: (
              <div className="grid gap-group lg:grid-cols-2">
                <Stack gap={4}>
                  <IndexCard project={project} />
                  <RepositorySignals projectId={project.id} />
                </Stack>
                <ExplainForm projectId={project.id} />
              </div>
            ),
          },
          {
            value: "danger",
            label: "Danger zone",
            content: <DeleteProjectData key={project.id} project={project} />,
          },
        ]}
      />
    </Page>
  );
}

/** Bootstrap (re-index) the project and search its index. */
export function IndexCard({ project }: { project: Project }) {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const [busy, setBusy] = useState<"boot" | "search" | null>(null);
  const [boot, setBoot] = useState<BootstrapResult | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // A search still running when the project changes must not show its results afterwards.
  const currentProject = useRef(state.projectId);
  currentProject.current = state.projectId;
  useEffect(() => setHits(null), [state.projectId]);

  const search = async () => {
    const projectId = project.id;
    if (!q.trim()) return;
    setBusy("search");
    try {
      const found = await api.search(projectId, q.trim());
      if (currentProject.current === projectId) setHits(found);
    } catch (e) {
      report(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Project index"
      term="Project index"
      description="Bootstrap reads the repository's docs, ADRs and manifests into a local index the Director and planner cite."
      actions={
        <Button
          variant="secondary"
          size="sm"
          loading={busy === "boot"}
          onClick={() => {
            setBusy("boot");
            api
              .bootstrap(project.id)
              .then((result) => {
                setBoot(result);
                dispatch({
                  type: "notice",
                  notice: {
                    kind: "info",
                    text: `Bootstrap finished: ${result.indexed.length} files indexed`,
                  },
                });
              }, report)
              .finally(() => setBusy(null));
          }}
        >
          Bootstrap <span className="sr-only">{project.name}</span>
        </Button>
      }
    >
      <Stack gap={4}>
        {boot ? <BootstrapSummary result={boot} /> : null}
        <form
          role="search"
          className="flex flex-wrap gap-2 sm:flex-nowrap"
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
          <Button
            type="submit"
            {...(!q.trim() ? { disabledReason: "Type something to search for" } : {})}
            loading={busy === "search"}
          >
            Search
          </Button>
        </form>
        {hits === null ? null : hits.length === 0 ? (
          <Empty body="Bootstrap the project first if you have not.">No matches.</Empty>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Search results">
            {hits.map((h) => (
              <li key={h.chunkId} className="min-w-0 rounded-md border border-line bg-sunken p-3">
                <p className="font-mono text-xs break-all">
                  {h.path}#L{h.startLine}-L{h.endLine} <Badge>{h.kind}</Badge>
                </p>
                <pre className="mt-1 max-h-40 overflow-auto text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {h.text}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </Stack>
    </Card>
  );
}

/** Typed-confirmation delete of one project's data; erasing evidence also needs approval. */
export function DeleteProjectData({ project }: { project: Project }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [eraseEvidence, setEraseEvidence] = useState(false);
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [, setUnlockTick] = useState(0);

  const reason =
    confirm !== project.name
      ? `Type "${project.name}" to confirm`
      : eraseEvidence && eraseConfirm !== "ERASE EVIDENCE"
        ? "Type ERASE EVIDENCE to confirm"
        : eraseEvidence && !api.hasApprovalSession()
          ? "Erasing evidence needs the approval pairing code"
          : busy
            ? "Deleting…"
            : undefined;

  return (
    <Card title="Delete project data">
      <Stack gap={4}>
        <Callout tone="danger" title="This cannot be undone">
          Permanently deletes the index, inbox, specs and knowledge of{" "}
          <strong className="break-all">{project.name}</strong>. The repository itself is not
          touched.
        </Callout>
        <form
          aria-label="Delete project data"
          className="flex flex-col gap-field"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            (eraseEvidence
              ? api.deleteProjectData(project.id, confirm, { eraseEvidence: true })
              : api.deleteProjectData(project.id, confirm)
            )
              .then(({ deleted }) => {
                dispatch({ type: "projects/remove", projectId: project.id });
                setConfirm("");
                setEraseEvidence(false);
                setEraseConfirm("");
                dispatch({
                  type: "notice",
                  notice: {
                    kind: "info",
                    text:
                      `Deleted all data for ${project.name}` +
                      (deleted.evidenceErased !== undefined
                        ? ` (${deleted.evidenceErased} evidence records erased)`
                        : ""),
                  },
                });
              }, report)
              .finally(() => setBusy(false));
          }}
        >
          <Field label={`Type "${project.name}" to confirm`} id="delete-confirm">
            <input
              id="delete-confirm"
              className={inputClass}
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm" htmlFor="delete-erase-evidence">
            <input
              id="delete-erase-evidence"
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={eraseEvidence}
              onChange={(e) => {
                setEraseEvidence(e.target.checked);
                setEraseConfirm("");
              }}
            />
            <span>
              Also erase immutable task evidence (test results, review and Brokkr records). Only
              each record&apos;s id and hash are kept. Without this, a project with evidence cannot
              be deleted.
            </span>
          </label>
          {eraseEvidence && (
            <Field label="Type ERASE EVIDENCE to confirm" id="delete-erase-confirm" term="Evidence">
              <input
                id="delete-erase-confirm"
                className={inputClass}
                autoComplete="off"
                value={eraseConfirm}
                onChange={(e) => setEraseConfirm(e.target.value)}
              />
            </Field>
          )}
          <div>
            <Button type="submit" variant="danger" {...(reason ? { disabledReason: reason } : {})}>
              Delete project data
            </Button>
          </div>
        </form>
        {eraseEvidence ? (
          // Erasing evidence needs an approval; the unlock sits outside the form (no nested forms).
          <ApprovalUnlock id="erase-approval-code" onUnlocked={() => setUnlockTick((n) => n + 1)} />
        ) : null}
      </Stack>
    </Card>
  );
}
