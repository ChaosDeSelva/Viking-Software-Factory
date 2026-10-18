import type { Project } from "../api/types.js";

export type View =
  | "projects"
  | "inbox"
  | "director"
  | "specs"
  | "knowledge"
  | "settings"
  | "plans"
  | "harnesses"
  | "runs"
  | "reviews"
  | "deliveries";
export type Theme = "light" | "dark";
export interface Notice {
  kind: "info" | "error";
  text: string;
}

export interface State {
  token: string | null;
  view: View;
  theme: Theme;
  projects: Project[];
  projectId: string | null;
  /** Spec selected in the specs view. */
  specId: string | null;
  /** Plan, execution and delivery selected on their screens. */
  planId: string | null;
  executionId: string | null;
  deliveryId: string | null;
  notice: Notice | null;
}

export type Action =
  | { type: "token/set"; token: string }
  | { type: "token/clear" }
  | { type: "auth/rejected" }
  | { type: "navigate"; view: View }
  | { type: "project/select"; projectId: string }
  | { type: "projects/loaded"; projects: Project[] }
  | { type: "projects/upsert"; project: Project }
  | { type: "projects/remove"; projectId: string }
  | { type: "spec/open"; specId: string }
  | { type: "plan/open"; planId: string }
  | { type: "execution/open"; executionId: string }
  | { type: "delivery/open"; deliveryId: string }
  | {
      type: "route";
      route: Partial<
        Pick<State, "view" | "projectId" | "specId" | "planId" | "executionId" | "deliveryId">
      >;
    }
  | { type: "notice"; notice: Notice }
  | { type: "notice/dismiss" }
  | { type: "theme/toggle" };

export function initialState(init: { token?: string | null; theme?: Theme }): State {
  return {
    token: init.token ?? null,
    view: "projects",
    theme: init.theme ?? "light",
    projects: [],
    projectId: null,
    specId: null,
    planId: null,
    executionId: null,
    deliveryId: null,
    notice: null,
  };
}

/** Errors stay until dismissed (audit S-I5); info notices end with the view. */
const keepErrors = (n: Notice | null): Notice | null => (n?.kind === "error" ? n : null);

const NO_SELECTION = { planId: null, executionId: null, deliveryId: null } as const;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "token/set":
      return { ...state, token: action.token, notice: null };
    case "token/clear":
      return { ...state, token: null };
    case "auth/rejected":
      return {
        ...state,
        token: null,
        notice: { kind: "error", text: "The server rejected the token. Enter it again." },
      };
    case "navigate":
      return { ...state, view: action.view, notice: keepErrors(state.notice) };
    case "route":
      return { ...state, ...action.route, notice: keepErrors(state.notice) };
    case "project/select":
      return { ...state, projectId: action.projectId, specId: null, ...NO_SELECTION };
    case "projects/loaded":
      return {
        ...state,
        projects: action.projects,
        projectId:
          state.projectId && action.projects.some((p) => p.id === state.projectId)
            ? state.projectId
            : (action.projects[0]?.id ?? null),
      };
    case "projects/upsert": {
      const exists = state.projects.some((p) => p.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
          : [...state.projects, action.project],
        projectId: state.projectId ?? action.project.id,
      };
    }
    case "projects/remove": {
      const projects = state.projects.filter((p) => p.id !== action.projectId);
      return {
        ...state,
        projects,
        projectId:
          state.projectId === action.projectId ? (projects[0]?.id ?? null) : state.projectId,
        specId: state.projectId === action.projectId ? null : state.specId,
        ...(state.projectId === action.projectId ? NO_SELECTION : {}),
      };
    }
    case "spec/open":
      return { ...state, view: "specs", specId: action.specId };
    case "plan/open":
      return { ...state, view: "plans", planId: action.planId, notice: keepErrors(state.notice) };
    case "execution/open":
      return {
        ...state,
        view: "runs",
        executionId: action.executionId,
        notice: keepErrors(state.notice),
      };
    case "delivery/open":
      return {
        ...state,
        view: "deliveries",
        deliveryId: action.deliveryId,
        notice: keepErrors(state.notice),
      };
    case "notice":
      return { ...state, notice: action.notice };
    case "notice/dismiss":
      return { ...state, notice: null };
    case "theme/toggle":
      return { ...state, theme: state.theme === "dark" ? "light" : "dark" };
  }
}
