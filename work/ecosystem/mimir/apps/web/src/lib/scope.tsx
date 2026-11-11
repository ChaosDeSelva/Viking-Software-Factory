/**
 * The selected project. Every top-bar page shows only this project's missions and what hangs off
 * them (crews, tasks, agents, approvals, events); `null` is the operator's "All projects" view.
 * The choice lives in `?project=` (shareable, carried across factory apps) and in localStorage.
 */
import type { EventEnvelope, Project } from "@mimir/protocol";
import type { Scope } from "@factory/ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import type { State } from "../store/reducer.js";
import { useStore } from "../store/StoreProvider.js";

const KEY = "mimir.project";
export const PROJECT_PARAM = "project";

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

interface ScopeValue {
  /** null: All projects. */
  projectId: string | null;
  project: Project | null;
  setProjectId: (id: string | null) => void;
}

const ScopeContext = createContext<ScopeValue>({
  projectId: null,
  project: null,
  setProjectId: () => undefined,
});

export function ProjectScopeProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const { search, pathname } = useLocation();
  const navigate = useNavigate();
  const fromUrl = new URLSearchParams(search).get(PROJECT_PARAM);
  const [chosen, setChosen] = useState<string | null>(() => fromUrl ?? readStored());

  // A link with ?project= (a shared URL) wins over the stored choice; only URL changes re-run this.
  useEffect(() => {
    if (fromUrl !== null && fromUrl !== chosen) setChosen(fromUrl);
  }, [fromUrl]);

  // `chosen` null: never chosen (a lone project is selected); "": All projects on purpose. An
  // unknown or deleted project falls back to All.
  const ready = state.status === "ready";
  const only = state.projects.length === 1 ? state.projects[0]!.id : null;
  const projectId =
    chosen === null
      ? only
      : chosen === ""
        ? null
        : !ready || state.projects.some((p) => p.id === chosen)
          ? chosen
          : null;

  // Keep the URL in step on every page, so a copied link opens the same scope.
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(search);
    if ((params.get(PROJECT_PARAM) ?? null) === projectId) return;
    if (projectId === null) params.delete(PROJECT_PARAM);
    else params.set(PROJECT_PARAM, projectId);
    const qs = params.toString();
    void navigate(
      { pathname, search: qs ? `?${qs}` : "", hash: window.location.hash },
      { replace: true },
    );
  }, [ready, projectId, pathname, search, navigate]);

  const setProjectId = useCallback((id: string | null) => {
    setChosen(id ?? "");
    try {
      localStorage.setItem(KEY, id ?? "");
    } catch {
      // Storage blocked: the URL still carries the choice.
    }
  }, []);

  const value = useMemo<ScopeValue>(
    () => ({
      projectId,
      project: state.projects.find((p) => p.id === projectId) ?? null,
      setProjectId,
    }),
    [projectId, state.projects, setProjectId],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useProjectScope(): ScopeValue {
  return useContext(ScopeContext);
}

/** For PageHeader's scope chip. */
export function usePageScope(): Scope {
  const { project } = useProjectScope();
  return { project: project?.name ?? null };
}

export type ScopedState = Pick<
  State,
  | "missions"
  | "crews"
  | "tasks"
  | "taskDependencies"
  | "agents"
  | "approvals"
  | "worktrees"
  | "events"
> & {
  /** Mission ids in scope; null when All projects. */
  missionIds: ReadonlySet<string> | null;
  inScope: (e: { missionId?: string | null | undefined }) => boolean;
  eventInScope: (e: EventEnvelope) => boolean;
};

/** Filters the store to one project. Records reach a project only through their mission. */
export function scopeState(state: State, projectId: string | null): ScopedState {
  if (projectId === null) {
    return {
      missions: state.missions,
      crews: state.crews,
      tasks: state.tasks,
      taskDependencies: state.taskDependencies,
      agents: state.agents,
      approvals: state.approvals,
      worktrees: state.worktrees,
      events: state.events,
      missionIds: null,
      inScope: () => true,
      eventInScope: () => true,
    };
  }
  const missions = state.missions.filter((m) => m.projectId === projectId);
  const missionIds = new Set<string>(missions.map((m) => m.id));
  const inScope = (e: { missionId?: string | null | undefined }) =>
    e.missionId != null && missionIds.has(e.missionId);
  const crews = state.crews.filter(inScope);
  const crewIds = new Set<string>(crews.map((c) => c.id));
  const tasks = state.tasks.filter(inScope);
  const taskIds = new Set<string>(tasks.map((t) => t.id));
  const eventInScope = (e: EventEnvelope) => {
    if (e.missionId !== undefined) return missionIds.has(e.missionId);
    if (e.crewId !== undefined) return crewIds.has(e.crewId);
    if (e.taskId !== undefined) return taskIds.has(e.taskId);
    // Project events carry the project in the payload, not the envelope.
    const p = e.payload as { project?: { id?: unknown } } | null;
    return p?.project?.id === projectId;
  };
  return {
    missions,
    crews,
    tasks,
    taskDependencies: state.taskDependencies.filter((d) => taskIds.has(d.taskId)),
    agents: state.agents.filter((a) => crewIds.has(a.crewId)),
    approvals: state.approvals.filter(
      (a) =>
        (a.missionId !== null && missionIds.has(a.missionId)) ||
        (a.taskId !== null && taskIds.has(a.taskId)),
    ),
    worktrees: state.worktrees.filter((w) => taskIds.has(w.taskId)),
    events: state.events.filter(eventInScope),
    missionIds,
    inScope,
    eventInScope,
  };
}

export function useScoped(): ScopedState {
  const { state } = useStore();
  const { projectId } = useProjectScope();
  return useMemo(() => scopeState(state, projectId), [state, projectId]);
}

/**
 * Attention items name a mission, task or session, not a project; keep those that resolve into
 * the selected project (all of them for All projects).
 */
export function attentionInScope(
  item: {
    missionId?: string | undefined;
    taskId?: string | undefined;
    sessionId?: string | undefined;
  },
  scoped: ScopedState,
): boolean {
  if (scoped.missionIds === null) return true;
  if (item.missionId !== undefined) return scoped.missionIds.has(item.missionId);
  if (item.taskId !== undefined) return scoped.tasks.some((t) => t.id === item.taskId);
  if (item.sessionId !== undefined)
    return scoped.agents.some((a) => a.runtimeSessionId === item.sessionId);
  return false;
}
