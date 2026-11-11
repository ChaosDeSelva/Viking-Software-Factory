import {
  acceptNeedsApproval,
  type Decision,
  type DecisionQuery,
  type FeedbackGraphStatus,
  type ProjectFeedbackGraph,
  type StewardMode,
  type StewardNote,
  type StewardStatus,
  type StewardType,
} from "./steward-types.js";

/** `approval: true` sends the approval factor on a route the path pattern cannot classify. */
type Call = <T>(
  method: string,
  path: string,
  body?: unknown,
  o?: { approval?: boolean },
) => Promise<T>;

const enc = encodeURIComponent;

function decisionQuery(q: DecisionQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Client methods for the steward (Autonomy page) and the Feedback Graph link. */
export function stewardMethods(call: Call) {
  return {
    stewardStatus: () => call<StewardStatus>("GET", "/v1/steward/status"),
    /** Approval-gated (the path is in APPROVAL_ROUTE). */
    setStewardMode: async (type: string, mode: StewardMode) =>
      (await call<{ types: StewardType[] }>("PUT", "/v1/steward/modes", { type, mode })).types,
    pauseSteward: () => call<StewardStatus>("POST", "/v1/steward/pause"),
    resumeSteward: () => call<StewardStatus>("POST", "/v1/steward/resume"),
    listDecisions: async (q: DecisionQuery = {}) =>
      (await call<{ decisions: Decision[] }>("GET", `/v1/steward/decisions${decisionQuery(q)}`))
        .decisions,
    getDecision: async (id: string) =>
      (await call<{ decision: Decision }>("GET", `/v1/steward/decisions/${enc(id)}`)).decision,
    /**
     * Accepts a recommendation; `value` is an edited answer (recorded as "changed"). Approval-type
     * decisions perform an approval, so they carry the approval factor.
     */
    acceptDecision: async (decision: { id: string; type: string }, value?: string) =>
      (
        await call<{ decision: Decision }>(
          "POST",
          `/v1/steward/decisions/${enc(decision.id)}/accept`,
          value === undefined ? {} : { value },
          { approval: acceptNeedsApproval(decision.type) },
        )
      ).decision,
    rejectDecision: async (id: string, reason?: string) =>
      (
        await call<{ decision: Decision }>(
          "POST",
          `/v1/steward/decisions/${enc(id)}/reject`,
          reason ? { reason } : {},
        )
      ).decision,
    rollbackDecision: async (id: string, reason: string) =>
      (
        await call<{ decision: Decision }>("POST", `/v1/steward/decisions/${enc(id)}/rollback`, {
          reason,
        })
      ).decision,
    addDecisionNote: async (id: string, text: string) =>
      (
        await call<{ decision: Decision }>("POST", `/v1/steward/decisions/${enc(id)}/notes`, {
          text,
        })
      ).decision,
    /** Without a project: every note the server returns for no project filter. */
    listStewardNotes: async (projectId?: string | null) =>
      (
        await call<{ notes: StewardNote[] }>(
          "GET",
          `/v1/steward/notes${projectId ? `?${new URLSearchParams({ projectId }).toString()}` : ""}`,
        )
      ).notes,
    /** `projectId: null` adds a global note. */
    addStewardNote: async (projectId: string | null, text: string) =>
      (await call<{ note: StewardNote }>("POST", "/v1/steward/notes", { projectId, text })).note,

    feedbackGraphStatus: () => call<FeedbackGraphStatus>("GET", "/v1/feedback-graph/status"),
    getProjectFeedbackGraph: (projectId: string) =>
      call<ProjectFeedbackGraph>("GET", `/v1/projects/${enc(projectId)}/feedback-graph`),
    /** `null` clears the override (back to the automatic match). */
    setProjectFeedbackGraph: (projectId: string, projectKey: string | null) =>
      call<ProjectFeedbackGraph>("PUT", `/v1/projects/${enc(projectId)}/feedback-graph`, {
        projectKey,
      }),
  };
}

/** Method names, for test mocks. */
export const STEWARD_METHOD_NAMES = [
  "stewardStatus",
  "setStewardMode",
  "pauseSteward",
  "resumeSteward",
  "listDecisions",
  "getDecision",
  "acceptDecision",
  "rejectDecision",
  "rollbackDecision",
  "addDecisionNote",
  "listStewardNotes",
  "addStewardNote",
  "feedbackGraphStatus",
  "getProjectFeedbackGraph",
  "setProjectFeedbackGraph",
] as const satisfies readonly (keyof ReturnType<typeof stewardMethods>)[];
