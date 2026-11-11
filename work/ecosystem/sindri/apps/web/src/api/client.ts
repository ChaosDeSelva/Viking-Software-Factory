export interface KnowledgeProposal {
  id: string;
  claim: string;
  status: "proposed" | "accepted" | "rejected";
  sourceRefs: { taskEvidenceId: string }[];
}
/** An earlier change request on a delivery, with the spec versions drafted for it. */
export interface ReworkSummary {
  id: string;
  feedback: string;
  createdAt: string;
  baseCommits: string[];
  specs: { id: string; version: number; status: string; title: string }[];
}
import type {
  BootstrapResult,
  Capabilities,
  DraftResult,
  ExecutionProfile,
  Intake,
  IntakeComment,
  KnowledgeEntry,
  NewKnowledge,
  OpenQuestion,
  Project,
  SearchHit,
  Settings,
  Spec,
  SpecDetail,
  SpecDiff,
  SpecMeta,
} from "./types.js";
import { deliveryMethods } from "./delivery-client.js";
import { stewardMethods } from "./steward-client.js";

/** An API failure carrying the server's `{ error: { code, message } }` envelope. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof globalThis.fetch;
  /** Idempotency-Key generator for mutations. */
  newKey?: () => string;
}

const enc = encodeURIComponent;

/**
 * Routes that need the approval secret: spec and plan approval, PR requests (audit M9),
 * decisions on agents' gated actions (review I1), a project's execution profile and the
 * steward's per-type modes. Accepting a steward decision is gated only for approval types, which
 * the path cannot tell, so those calls pass `approval: true` instead.
 */
const APPROVAL_ROUTE =
  /^\/v1\/(?:(?:specs|plans)\/[^/]+\/approve|executions\/[^/]+\/(?:pr|approvals\/[^/]+)|projects\/[^/]+\/(?:data|profile)|deliveries\/[^/]+\/proposals(?:\/[^/]+\/decision)?|steward\/modes)$/;
const APPROVAL_HEADER = "x-sindri-approval";
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

export function createApiClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const newKey = opts.newKey ?? (() => crypto.randomUUID());

  // The approval secret lives in this closure only: never in localStorage, sessionStorage or the
  // store, so it is gone when the tab closes (audit M9).
  let approvalSecret: string | null = null;

  async function send(
    method: string,
    path: string,
    body?: unknown,
    o: { approval?: boolean } = {},
  ): Promise<Response> {
    const headers = new Headers();
    const token = opts.getToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const route = path.split("?")[0] ?? "";
    // No read is gated (a profile and a delivery's proposals are read on gated paths), so a GET
    // never carries the secret.
    const approvalRoute = method !== "GET" && (o.approval === true || APPROVAL_ROUTE.test(route));
    if (approvalRoute && approvalSecret) headers.set(APPROVAL_HEADER, approvalSecret);
    const init: RequestInit = { method, headers };
    if (method !== "GET") {
      headers.set("idempotency-key", newKey());
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, init);
    } catch {
      throw new ApiError(0, "network_error", "Cannot reach the Sindri server");
    }
    if (!res.ok) {
      let code = "http_error";
      let message = `Request failed (${res.status})`;
      let details: unknown;
      try {
        const env = (await res.json()) as {
          error?: { code?: string; message?: string; details?: unknown };
        };
        if (env.error?.code) code = env.error.code;
        if (env.error?.message) message = env.error.message;
        details = env.error?.details;
      } catch {
        /* not JSON */
      }
      if (approvalRoute && code === "approval_required") approvalSecret = null;
      throw new ApiError(res.status, code, message, details);
    }
    return res;
  }
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    o?: { approval?: boolean },
  ): Promise<T> => (await (await send(method, path, body, o)).json()) as T;

  return {
    listProposals: async (id: string) =>
      (await call<{ proposals: KnowledgeProposal[] }>("GET", `/v1/deliveries/${enc(id)}/proposals`))
        .proposals,
    proposeKnowledge: async (id: string) =>
      (
        await call<{ proposals: KnowledgeProposal[] }>(
          "POST",
          `/v1/deliveries/${enc(id)}/proposals`,
        )
      ).proposals,
    decideProposal: (id: string, proposalId: string, decision: "accepted" | "rejected") =>
      call("POST", `/v1/deliveries/${enc(id)}/proposals/${enc(proposalId)}/decision`, { decision }),
    /** Reviewer feedback on a delivery; returns the specification drafted for the rework. */
    requestRework: (id: string, feedback: string) =>
      call<{ rework: { id: string }; spec: Spec }>("POST", `/v1/deliveries/${enc(id)}/rework`, {
        feedback,
      }),
    listReworks: async (id: string) =>
      (await call<{ reworks: ReworkSummary[] }>("GET", `/v1/deliveries/${enc(id)}/reworks`))
        .reworks,
    health: () => call<{ status: string }>("GET", "/v1/health"),
    capabilities: () => call<Capabilities>("GET", "/v1/capabilities"),

    listProjects: async () => (await call<{ projects: Project[] }>("GET", "/v1/projects")).projects,
    getProject: async (id: string) =>
      (await call<{ project: Project }>("GET", `/v1/projects/${enc(id)}`)).project,
    createProject: async (input: { name: string; repoPath: string }) =>
      (await call<{ project: Project }>("POST", "/v1/projects", input)).project,
    bootstrap: async (id: string) =>
      (await call<{ result: BootstrapResult }>("POST", `/v1/projects/${enc(id)}/bootstrap`)).result,
    search: async (id: string, q: string) =>
      (await call<{ hits: SearchHit[] }>("GET", `/v1/projects/${enc(id)}/search?${qs({ q })}`))
        .hits,
    getProfile: async (id: string) =>
      (await call<{ profile: ExecutionProfile }>("GET", `/v1/projects/${enc(id)}/profile`)).profile,
    /** Replaces the whole profile. `harness` is null when the profile has no checks. */
    putProfile: (id: string, profile: ExecutionProfile) =>
      call<{ profile: ExecutionProfile; harness: { name: string; version: string } | null }>(
        "PUT",
        `/v1/projects/${enc(id)}/profile`,
        profile,
      ),
    /** `eraseEvidence` also erases immutable task evidence (ids and hashes are kept). */
    deleteProjectData: (id: string, confirm: string, o: { eraseEvidence?: boolean } = {}) =>
      call<{ deleted: { projectId: string; evidenceErased?: number } }>(
        "DELETE",
        `/v1/projects/${enc(id)}/data`,
        { confirm, ...(o.eraseEvidence === true ? { eraseEvidence: true } : {}) },
      ),

    listIntakes: async (projectId: string) =>
      (await call<{ intakes: Intake[] }>("GET", `/v1/intakes?${qs({ projectId })}`)).intakes,
    getIntake: (id: string) =>
      call<{ intake: Intake; comments: IntakeComment[] }>("GET", `/v1/intakes/${enc(id)}`),
    createIntake: async (input: { projectId: string; title: string; body: string }) =>
      (await call<{ intake: Intake }>("POST", "/v1/intakes", input)).intake,
    importIntake: async (input: { projectId: string; url: string }) =>
      (await call<{ intake: Intake }>("POST", "/v1/intakes/import", input)).intake,

    draft: (input: { projectId: string; intakeId?: string; request: string }) =>
      call<DraftResult>("POST", "/v1/director/draft", input),
    questions: async (specId: string) =>
      (await call<{ questions: OpenQuestion[] }>("GET", `/v1/specs/${enc(specId)}/questions`))
        .questions,
    answer: (specId: string, questionId: string, answer: string) =>
      call<{ spec: Spec; meta: SpecMeta }>("POST", `/v1/specs/${enc(specId)}/answer`, {
        questionId,
        answer,
      }),

    listSpecs: async (projectId: string) =>
      (await call<{ specs: Spec[] }>("GET", `/v1/specs?${qs({ projectId })}`)).specs,
    getSpec: (id: string) => call<SpecDetail>("GET", `/v1/specs/${enc(id)}`),
    renderSpec: async (id: string) =>
      (await call<{ markdown: string }>("GET", `/v1/specs/${enc(id)}/render`)).markdown,
    diffSpecs: async (from: string, to: string) =>
      (await call<{ diff: SpecDiff }>("GET", `/v1/specs/diff?${qs({ from, to })}`)).diff,
    submitSpec: async (id: string) =>
      (await call<{ spec: Spec }>("POST", `/v1/specs/${enc(id)}/submit`)).spec,
    /** Trade the pairing code shown by `sindri start` for an in-memory approval secret. */
    unlockApprovals: async (pairingCode: string) => {
      const session = await call<{ approvalSecret: string; principal: string; expiresAt: string }>(
        "POST",
        "/v1/approval-session",
        { pairingCode: pairingCode.trim(), channel: "web" },
      );
      approvalSecret = session.approvalSecret;
      return { principal: session.principal, expiresAt: session.expiresAt };
    },
    hasApprovalSession: () => approvalSecret !== null,
    /** Sign-out and a rejected token end the approval session too. */
    forgetApproval: () => {
      approvalSecret = null;
    },
    /** The approver is the server-side approval principal; flagged specs need acknowledgement. */
    approveSpec: async (id: string, opts: { acknowledgeUntrusted?: boolean } = {}) =>
      (
        await call<{ spec: Spec }>(
          "POST",
          `/v1/specs/${enc(id)}/approve`,
          opts.acknowledgeUntrusted ? { acknowledgeUntrusted: true } : {},
        )
      ).spec,
    reviseSpec: async (id: string, patch: { title?: string; body?: Record<string, unknown> }) =>
      (await call<{ spec: Spec }>("POST", `/v1/specs/${enc(id)}/revise`, patch)).spec,

    listKnowledge: async (projectId: string, q?: string) =>
      (
        await call<{ entries: KnowledgeEntry[] }>(
          "GET",
          `/v1/knowledge?${qs(q ? { projectId, q } : { projectId })}`,
        )
      ).entries,
    addKnowledge: async (projectId: string, entry: NewKnowledge) =>
      (await call<{ entry: KnowledgeEntry }>("POST", "/v1/knowledge", { projectId, ...entry }))
        .entry,
    retractKnowledge: async (id: string, reason: string) =>
      (
        await call<{ entry: KnowledgeEntry }>("POST", `/v1/knowledge/${enc(id)}/retract`, {
          reason,
        })
      ).entry,
    supersedeKnowledge: async (id: string, entry: NewKnowledge) =>
      (await call<{ entry: KnowledgeEntry }>("POST", `/v1/knowledge/${enc(id)}/supersede`, entry))
        .entry,
    knowledgeHistory: async (id: string) =>
      (await call<{ history: KnowledgeEntry[] }>("GET", `/v1/knowledge/${enc(id)}/history`))
        .history,

    getSettings: () =>
      call<{ settings: Settings; tokenLocation: string | null }>("GET", "/v1/settings"),
    putSettings: async (settings: Settings) =>
      (await call<{ settings: Settings }>("PUT", "/v1/settings", settings)).settings,
    exportData: async () => (await send("GET", "/v1/export")).blob(),
    ...deliveryMethods(call, send),
    ...stewardMethods(call),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
