import {
  GetTaskResponseSchema,
  CrewSchedulingResponseSchema,
  SessionObservationResponseSchema,
  VerifyTaskResponseSchema,
  type GetTaskResponse,
  type CrewId,
  type CrewSchedulingRequest,
  type CrewSchedulingResponse,
  type SessionObservationResponse,
  type VerifyTaskResponse,
} from "@mimir/protocol";
import {
  CapabilitiesResponseSchema,
  CreateCrewResponseSchema,
  CreateMissionResponseSchema,
  CreateProjectResponseSchema,
  CreateTaskResponseSchema,
  GetArtifactResponseSchema,
  MimirError,
  GetMissionResponseSchema,
  HealthResponseSchema,
  ListApprovalsResponseSchema,
  ListCrewsResponseSchema,
  ListMissionsResponseSchema,
  ListProjectsResponseSchema,
  ListTasksResponseSchema,
  OperationAcceptedSchema,
  RequestPrResponseSchema,
  SnapshotResponseSchema,
  UsageResponseSchema,
  type ApprovalDecisionRequest,
  type ApprovalId,
  type ArtifactId,
  type CancelMissionRequest,
  type CapabilitiesResponse,
  type CreateCrewRequest,
  type CreateCrewResponse,
  type CreateMissionRequest,
  type CreateMissionResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type GetArtifactResponse,
  type GetMissionResponse,
  type HealthResponse,
  type ListApprovalsQuery,
  type ListApprovalsResponse,
  type ListCrewsQuery,
  type ListCrewsResponse,
  type ListEventsQueryInput,
  type ListMissionsQuery,
  type ListMissionsResponse,
  type ListProjectsResponse,
  type ListTasksQuery,
  type ListTasksResponse,
  type MissionId,
  type OperationAccepted,
  type RequestPrResponse,
  type RetryTaskRequest,
  type SendInstructionRequest,
  type SessionId,
  type SnapshotResponse,
  type StartMissionRequest,
  type StopSessionRequest,
  type TaskId,
  type UsageQuery,
  type UsageResponse,
} from "@mimir/protocol";
import {
  listEvents,
  replayAll,
  streamEvents,
  type EventsPage,
  type EventStream,
  type ReplayAllOptions,
  type ReplayAllResult,
  type StreamOptions,
} from "./events.js";
import {
  AttentionResponseSchema,
  TerminalReadResponseSchema,
  type AttentionResponse,
  type TerminalReadResponse,
} from "./provisional.js";
import { Http, type HttpOptions, type MutationOptions, type RequestOptions } from "./http.js";

export interface MimirClientOptions extends HttpOptions {
  /** Server origin, e.g. `http://127.0.0.1:7700`. */
  baseUrl: string;
}

export interface MimirClient {
  health(options?: RequestOptions): Promise<HealthResponse>;
  capabilities(options?: RequestOptions): Promise<CapabilitiesResponse>;
  snapshot(options?: RequestOptions): Promise<SnapshotResponse>;
  projects: {
    list(options?: RequestOptions): Promise<ListProjectsResponse>;
    create(body: CreateProjectRequest, options?: MutationOptions): Promise<CreateProjectResponse>;
  };
  missions: {
    list(query?: ListMissionsQuery, options?: RequestOptions): Promise<ListMissionsResponse>;
    get(id: MissionId, options?: RequestOptions): Promise<GetMissionResponse>;
    create(body: CreateMissionRequest, options?: MutationOptions): Promise<CreateMissionResponse>;
    start(
      id: MissionId,
      body?: StartMissionRequest,
      options?: MutationOptions,
    ): Promise<OperationAccepted>;
    cancel(
      id: MissionId,
      body?: CancelMissionRequest,
      options?: MutationOptions,
    ): Promise<OperationAccepted>;
  };
  crews: {
    pause(
      id: CrewId,
      body?: CrewSchedulingRequest,
      options?: MutationOptions,
    ): Promise<CrewSchedulingResponse>;
    resume(
      id: CrewId,
      body?: CrewSchedulingRequest,
      options?: MutationOptions,
    ): Promise<CrewSchedulingResponse>;
    list(query?: ListCrewsQuery, options?: RequestOptions): Promise<ListCrewsResponse>;
    create(body: CreateCrewRequest, options?: MutationOptions): Promise<CreateCrewResponse>;
  };
  tasks: {
    get(id: TaskId, options?: RequestOptions): Promise<GetTaskResponse>;
    verify(
      id: TaskId,
      body?: RetryTaskRequest,
      options?: MutationOptions,
    ): Promise<VerifyTaskResponse>;
    list(query?: ListTasksQuery, options?: RequestOptions): Promise<ListTasksResponse>;
    /** `POST /v1/tasks`: adds one task to a mission that is not yet terminal. */
    create(body: CreateTaskRequest, options?: MutationOptions): Promise<CreateTaskResponse>;
    retry(
      id: TaskId,
      body?: RetryTaskRequest,
      options?: MutationOptions,
    ): Promise<OperationAccepted>;
    /**
     * `POST /v1/tasks/:id/pr`: request delivery of a completed task. `approval_required` names the
     * `pr.create` approval a human must decide; `delivered` once delivery ran (`prUrl` when seen).
     * Mimir never pushes or merges.
     */
    requestPr(id: TaskId, options?: MutationOptions): Promise<RequestPrResponse>;
  };
  approvals: {
    list(query?: ListApprovalsQuery, options?: RequestOptions): Promise<ListApprovalsResponse>;
    decide(
      id: ApprovalId,
      body: ApprovalDecisionRequest,
      options?: MutationOptions,
    ): Promise<OperationAccepted>;
  };
  sessions: {
    get(id: SessionId, options?: RequestOptions): Promise<SessionObservationResponse>;
    input(
      id: SessionId,
      body: SendInstructionRequest,
      options?: MutationOptions,
    ): Promise<OperationAccepted>;
    stop(
      id: SessionId,
      body: StopSessionRequest,
      options?: MutationOptions,
    ): Promise<OperationAccepted>;
    /** `GET /v1/sessions/:id/terminal?lines=` (T12; provisional shape, see `TerminalReadResponse`). */
    terminal(
      id: SessionId,
      query?: { lines?: number },
      options?: RequestOptions,
    ): Promise<TerminalReadResponse>;
  };
  attention: {
    /** `GET /v1/attention` (T12; provisional shape, see `AttentionItem`). */
    list(options?: RequestOptions): Promise<AttentionResponse>;
  };
  events: {
    /** One page of `GET /v1/events` (normalized, see `EventsPage`). */
    list(query?: ListEventsQueryInput, options?: RequestOptions): Promise<EventsPage>;
    /** Live SSE feed with reconnect, resume and de-duplication. */
    stream(options?: StreamOptions): EventStream;
    /** Pages `GET /v1/events` to the end; returns the events and the final cursor. */
    replayAll(options?: ReplayAllOptions): Promise<ReplayAllResult>;
  };
  artifacts: {
    get(id: ArtifactId, options?: RequestOptions): Promise<GetArtifactResponse>;
    /** `GET /v1/artifacts/:id/content`: the stored bytes, their content type and the artifact hash. */
    content(id: ArtifactId, options?: RequestOptions): Promise<ArtifactContent>;
  };
  usage: {
    get(query?: UsageQuery, options?: RequestOptions): Promise<UsageResponse>;
  };
}

/** Raw artifact content from `GET /v1/artifacts/:id/content`. */
export interface ArtifactContent {
  bytes: Uint8Array;
  /** The served `Content-Type` (follows the artifact kind); `application/octet-stream` if absent. */
  contentType: string;
  /** The artifact's recorded hash (`x-artifact-hash`). */
  hash: string;
}

const seg = (id: string) => encodeURIComponent(id);

async function artifactContent(
  http: Http,
  id: ArtifactId,
  options?: RequestOptions,
): Promise<ArtifactContent> {
  const path = `/v1/artifacts/${seg(id)}/content`;
  const { bytes, headers } = await http.getRaw(path, options);
  const hash = headers.get("x-artifact-hash");
  if (hash === null || hash === "") {
    throw new MimirError("validation_failed", `response from ${path} has no x-artifact-hash`, {
      path,
      issues: [{ path: ["headers", "x-artifact-hash"], message: "required header is missing" }],
    });
  }
  return {
    bytes,
    contentType: headers.get("content-type") ?? "application/octet-stream",
    hash,
  };
}

/** Typed client for the Mimir HTTP + SSE API. Works in Node 25 and modern browsers. */
export function createMimirClient(options: MimirClientOptions): MimirClient {
  const http = new Http(options);
  const accepted = (path: string, body: unknown, o?: MutationOptions) =>
    http.post(OperationAcceptedSchema, path, body, o);

  return {
    health: (o) => http.get(HealthResponseSchema, "/v1/health", undefined, o),
    capabilities: (o) => http.get(CapabilitiesResponseSchema, "/v1/capabilities", undefined, o),
    snapshot: (o) => http.get(SnapshotResponseSchema, "/v1/snapshot", undefined, o),
    projects: {
      list: (o) => http.get(ListProjectsResponseSchema, "/v1/projects", undefined, o),
      create: (body, o) => http.post(CreateProjectResponseSchema, "/v1/projects", body, o),
    },
    missions: {
      list: (q, o) => http.get(ListMissionsResponseSchema, "/v1/missions", { ...q }, o),
      get: (id, o) => http.get(GetMissionResponseSchema, `/v1/missions/${seg(id)}`, undefined, o),
      create: (body, o) => http.post(CreateMissionResponseSchema, "/v1/missions", body, o),
      start: (id, body, o) => accepted(`/v1/missions/${seg(id)}/start`, body ?? {}, o),
      cancel: (id, body, o) => accepted(`/v1/missions/${seg(id)}/cancel`, body ?? {}, o),
    },
    crews: {
      pause: (id, body, o) =>
        http.post(CrewSchedulingResponseSchema, `/v1/crews/${seg(id)}/pause`, body ?? {}, o),
      resume: (id, body, o) =>
        http.post(CrewSchedulingResponseSchema, `/v1/crews/${seg(id)}/resume`, body ?? {}, o),
      list: (q, o) => http.get(ListCrewsResponseSchema, "/v1/crews", { ...q }, o),
      create: (body, o) => http.post(CreateCrewResponseSchema, "/v1/crews", body, o),
    },
    tasks: {
      get: (id, o) => http.get(GetTaskResponseSchema, `/v1/tasks/${seg(id)}`, undefined, o),
      verify: (id, body, o) =>
        http.post(VerifyTaskResponseSchema, `/v1/tasks/${seg(id)}/verify`, body ?? {}, o),
      list: (q, o) => http.get(ListTasksResponseSchema, "/v1/tasks", { ...q }, o),
      create: (body, o) => http.post(CreateTaskResponseSchema, "/v1/tasks", body, o),
      retry: (id, body, o) => accepted(`/v1/tasks/${seg(id)}/retry`, body ?? {}, o),
      requestPr: (id, o) => http.post(RequestPrResponseSchema, `/v1/tasks/${seg(id)}/pr`, {}, o),
    },
    approvals: {
      list: (q, o) => http.get(ListApprovalsResponseSchema, "/v1/approvals", { ...q }, o),
      decide: (id, body, o) => accepted(`/v1/approvals/${seg(id)}/decision`, body, o),
    },
    sessions: {
      get: (id, o) =>
        http.get(SessionObservationResponseSchema, `/v1/sessions/${seg(id)}`, undefined, o),
      input: (id, body, o) => accepted(`/v1/sessions/${seg(id)}/input`, body, o),
      stop: (id, body, o) => accepted(`/v1/sessions/${seg(id)}/stop`, body, o),
      terminal: (id, q, o) =>
        http.get(TerminalReadResponseSchema, `/v1/sessions/${seg(id)}/terminal`, { ...q }, o),
    },
    attention: {
      list: (o) => http.get(AttentionResponseSchema, "/v1/attention", undefined, o),
    },
    events: {
      list: (q, o) => listEvents(http, q, o),
      stream: (o) => streamEvents(http, o),
      replayAll: (o) => replayAll(http, o),
    },
    artifacts: {
      get: (id, o) => http.get(GetArtifactResponseSchema, `/v1/artifacts/${seg(id)}`, undefined, o),
      content: (id, o) => artifactContent(http, id, o),
    },
    usage: {
      get: (q, o) => http.get(UsageResponseSchema, "/v1/usage", { ...q }, o),
    },
  };
}
