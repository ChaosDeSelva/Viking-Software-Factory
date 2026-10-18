import {
  GetTaskResponseSchema,
  CrewSchedulingRequestSchema,
  CrewSchedulingResponseSchema,
  SessionObservationResponseSchema,
  VerifyTaskResponseSchema,
} from "@mimir/protocol";
/**
 * Generates the `contracts/` fixtures shipped in the SDK tarball: for each OpenAPI operation, a
 * real request/response exchange recorded against the fake Mimir server through this SDK, plus the
 * JSON Schemas of the request body and response (from the @mimir/protocol Zod schemas). Ids and
 * timestamps are replaced by stable placeholders so the output is deterministic.
 */
import {
  ApprovalDecisionRequestSchema,
  CancelMissionRequestSchema,
  CapabilitiesResponseSchema,
  CreateCrewRequestSchema,
  CreateCrewResponseSchema,
  CreateMissionRequestSchema,
  CreateMissionResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  EventEnvelopeSchema,
  GetArtifactResponseSchema,
  GetMissionResponseSchema,
  HealthResponseSchema,
  ID_PREFIX,
  ListApprovalsResponseSchema,
  ListCrewsResponseSchema,
  ListEventsResponseSchema,
  ListMissionsResponseSchema,
  ListProjectsResponseSchema,
  ListTasksResponseSchema,
  OperationAcceptedSchema,
  PROTOCOL_PACKAGE_VERSION,
  PROTOCOL_VERSION,
  RequestPrRequestSchema,
  RequestPrResponseSchema,
  RetryTaskRequestSchema,
  SendInstructionRequestSchema,
  SnapshotResponseSchema,
  StartMissionRequestSchema,
  StopSessionRequestSchema,
  UsageResponseSchema,
  ApiErrorBodySchema,
  generateOpenApi,
  jsonSchemaOf,
  newId,
} from "@mimir/protocol";
import { fakeMimirServer } from "@mimir/testing";
import { createMimirClient, type FetchLike } from "../src/index.js";

export interface ContractFixture {
  /** `METHOD /path/{param}` as in the OpenAPI document. */
  operation: string;
  method: string;
  path: string;
  /** Success status for the operation. */
  status: number;
  request: {
    url: string;
    query?: Record<string, string>;
    body?: unknown;
    /** Mutations send `idempotency-key`; all but health send `authorization: Bearer <token>`. */
    headers: string[];
  };
  response: {
    status: number;
    contentType: string;
    /** JSON body; for the SSE route, one event's `data:` payload. */
    body?: unknown;
    /** Raw bytes (artifact content), base64. */
    bodyBase64?: string;
    headers?: Record<string, string>;
  };
  schemas: { request?: unknown; response?: unknown };
}

type Schema = Parameters<typeof jsonSchemaOf>[0];

/** Protocol schemas per operation (request body, response body). Raw-content has no schema. */
export const CONTRACT_SCHEMAS: Record<string, { request?: Schema; response?: Schema }> = {
  "POST /v1/crews/{id}/pause": {
    request: CrewSchedulingRequestSchema,
    response: CrewSchedulingResponseSchema,
  },
  "POST /v1/crews/{id}/resume": {
    request: CrewSchedulingRequestSchema,
    response: CrewSchedulingResponseSchema,
  },
  "GET /v1/tasks/{id}": { response: GetTaskResponseSchema },
  "GET /v1/sessions/{id}": { response: SessionObservationResponseSchema },
  "POST /v1/tasks/{id}/verify": {
    request: RetryTaskRequestSchema,
    response: VerifyTaskResponseSchema,
  },
  "GET /v1/health": { response: HealthResponseSchema },
  "GET /v1/capabilities": { response: CapabilitiesResponseSchema },
  "GET /v1/snapshot": { response: SnapshotResponseSchema },
  "POST /v1/projects": {
    request: CreateProjectRequestSchema,
    response: CreateProjectResponseSchema,
  },
  "GET /v1/projects": { response: ListProjectsResponseSchema },
  "POST /v1/missions": {
    request: CreateMissionRequestSchema,
    response: CreateMissionResponseSchema,
  },
  "GET /v1/missions": { response: ListMissionsResponseSchema },
  "GET /v1/missions/{id}": { response: GetMissionResponseSchema },
  "POST /v1/missions/{id}/start": {
    request: StartMissionRequestSchema,
    response: OperationAcceptedSchema,
  },
  "POST /v1/missions/{id}/cancel": {
    request: CancelMissionRequestSchema,
    response: OperationAcceptedSchema,
  },
  "POST /v1/crews": { request: CreateCrewRequestSchema, response: CreateCrewResponseSchema },
  "GET /v1/crews": { response: ListCrewsResponseSchema },
  "GET /v1/tasks": { response: ListTasksResponseSchema },
  "POST /v1/tasks": { request: CreateTaskRequestSchema, response: CreateTaskResponseSchema },
  "POST /v1/tasks/{id}/retry": {
    request: RetryTaskRequestSchema,
    response: OperationAcceptedSchema,
  },
  "POST /v1/tasks/{id}/pr": { request: RequestPrRequestSchema, response: RequestPrResponseSchema },
  "GET /v1/approvals": { response: ListApprovalsResponseSchema },
  "POST /v1/approvals/{id}/decision": {
    request: ApprovalDecisionRequestSchema,
    response: OperationAcceptedSchema,
  },
  "POST /v1/sessions/{id}/input": {
    request: SendInstructionRequestSchema,
    response: OperationAcceptedSchema,
  },
  "POST /v1/sessions/{id}/stop": {
    request: StopSessionRequestSchema,
    response: OperationAcceptedSchema,
  },
  "GET /v1/events": { response: ListEventsResponseSchema },
  "GET /v1/events/stream": { response: EventEnvelopeSchema },
  "GET /v1/artifacts/{id}": { response: GetArtifactResponseSchema },
  "GET /v1/artifacts/{id}/content": {},
  "GET /v1/usage": { response: UsageResponseSchema },
};

const toJsonSchema = jsonSchemaOf;

export const fileFor = (operation: string) => {
  const [method, path] = operation.split(" ") as [string, string];
  return `${method.toLowerCase()}${path.replace(/[{}]/g, "").replace(/\//g, "-")}.json`;
};

interface Exchange {
  method: string;
  url: string;
  body?: unknown;
  headers: string[];
  status: number;
  contentType: string;
  json?: unknown;
  bytes?: Uint8Array;
  artifactHash?: string;
}

/** Replaces ids and timestamps with stable placeholders (first-seen order). */
function normalizer(): (value: unknown) => unknown {
  const ids = new Map<string, string>();
  const prefixes = Object.values(ID_PREFIX).join("|");
  const idPattern = new RegExp(`\\b(${prefixes})_[0-9A-HJKMNP-TV-Z]{26}\\b`, "g");
  const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
  const replaceIds = (s: string) =>
    s.replace(idPattern, (id, prefix: string) => {
      let stable = ids.get(id);
      if (stable === undefined) {
        stable = `${prefix}_${String(ids.size + 1).padStart(26, "0")}`;
        ids.set(id, stable);
      }
      return stable;
    });
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return timestamp.test(v) ? "2026-01-01T00:00:00.000Z" : replaceIds(v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [replaceIds(k), walk(x)]));
    }
    return v;
  };
  return walk;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Runs every operation once against the fake server; returns fixture file name → content. */
export async function generateContracts(): Promise<Map<string, unknown>> {
  const server = await fakeMimirServer();
  const exchanges: Exchange[] = [];
  const recording: FetchLike = async (input, init) => {
    const res = await globalThis.fetch(input, init);
    const url = new URL(input);
    const sent = new Headers(init?.headers);
    const ex: Exchange = {
      method: init?.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      headers: ["authorization", "idempotency-key"].filter((h) => sent.has(h)),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    exchanges.push(ex);
    if (ex.contentType.startsWith("text/event-stream")) return res;
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    if (ex.contentType.startsWith("application/json")) {
      ex.json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } else {
      ex.bytes = bytes;
      const hash = res.headers.get("x-artifact-hash");
      if (hash !== null) ex.artifactHash = hash;
    }
    return res;
  };
  let key = 0;
  const client = createMimirClient({
    baseUrl: server.url,
    token: server.token,
    fetch: recording,
    idempotencyKeyFactory: () => `contract-key-${++key}`,
  });

  try {
    const { project } = await client.projects.create({ name: "demo", repoPath: "/repo" });
    const { mission } = await client.missions.create({ projectId: project.id, objective: "ship" });
    const { crew } = await client.crews.create({
      missionId: mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "claude" }],
    });
    const failed = server.seedTask({ missionId: mission.id, crewId: crew.id, status: "failed" });
    const done = server.seedTask({ missionId: mission.id, crewId: crew.id, status: "completed" });
    const agent = server.seedAgent({ crewId: crew.id, taskId: failed.id });
    const approval = server.seedApproval({ missionId: mission.id, action: "shell.destructive" });
    const artifact = server.seedArtifact(
      { taskId: failed.id, kind: "test.output", hash: "sha256:00" },
      "1 passed\n",
    );
    server.seedUsageSample({ agentId: agent.id, tokens: 10, estimatedCost: 0.5 });
    const sessionId = agent.runtimeSessionId!;
    const { mission: open } = await client.missions.create({
      projectId: project.id,
      objective: "stays open",
    });

    const { crew: controlledCrew } = await client.crews.create({
      missionId: open.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const calls: Record<string, () => Promise<unknown>> = {
      "POST /v1/crews/{id}/pause": () => client.crews.pause(controlledCrew.id),
      "POST /v1/crews/{id}/resume": () => client.crews.resume(controlledCrew.id),
      "GET /v1/tasks/{id}": () => client.tasks.get(done.id),
      "POST /v1/tasks/{id}/verify": () => client.tasks.verify(done.id),
      "GET /v1/sessions/{id}": () => client.sessions.get(sessionId),
      "GET /v1/health": () => client.health(),
      "GET /v1/capabilities": () => client.capabilities(),
      "GET /v1/snapshot": () => client.snapshot(),
      "POST /v1/projects": () => client.projects.create({ name: "other", repoPath: "/other" }),
      "GET /v1/projects": () => client.projects.list(),
      "POST /v1/missions": () =>
        client.missions.create({
          projectId: project.id,
          objective: "with tasks",
          tasks: [{ title: "A", brief: "do A" }],
        }),
      "GET /v1/missions": () => client.missions.list({ projectId: project.id }),
      "GET /v1/missions/{id}": () => client.missions.get(mission.id),
      "POST /v1/missions/{id}/start": () => client.missions.start(open.id),
      "POST /v1/missions/{id}/cancel": () => client.missions.cancel(mission.id, { reason: "done" }),
      "POST /v1/crews": () =>
        client.crews.create({
          missionId: open.id,
          template: "pair",
          members: [{ role: "reviewer", agentKind: "codex", name: "rev" }],
        }),
      "GET /v1/crews": () => client.crews.list({ missionId: mission.id }),
      "GET /v1/tasks": () => client.tasks.list({ missionId: mission.id }),
      "POST /v1/tasks": () =>
        client.tasks.create({ missionId: open.id, title: "more", brief: "do more" }),
      "POST /v1/tasks/{id}/retry": () => client.tasks.retry(failed.id, { reason: "flaky" }),
      "POST /v1/tasks/{id}/pr": () => client.tasks.requestPr(done.id),
      "GET /v1/approvals": () => client.approvals.list({ status: "pending" }),
      "POST /v1/approvals/{id}/decision": () =>
        client.approvals.decide(approval.id, { decision: "approved" }),
      "POST /v1/sessions/{id}/input": () => client.sessions.input(sessionId, { text: "continue" }),
      "POST /v1/sessions/{id}/stop": () => client.sessions.stop(sessionId, { mode: "soft" }),
      "GET /v1/events": () => client.events.list({ limit: 2 }),
      "GET /v1/events/stream": async () => {
        const ac = new AbortController();
        const stream = client.events.stream({ cursor: "MA==", signal: ac.signal });
        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        ac.abort();
        await it.return?.();
        return first.value;
      },
      "GET /v1/artifacts/{id}": () => client.artifacts.get(artifact.id),
      "GET /v1/artifacts/{id}/content": () => client.artifacts.content(artifact.id),
      "GET /v1/usage": () => client.usage.get({ missionId: mission.id }),
    };

    const doc = generateOpenApi() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops).map(([m, op]) => ({
        operation: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        path,
        status: Number(Object.keys(op.responses).find((s) => /^2\d\d$/.test(s))),
      })),
    );

    const normalize = normalizer();
    const out = new Map<string, unknown>();
    const index: { operation: string; file: string; status: number }[] = [];
    for (const op of operations) {
      const call = calls[op.operation];
      if (!call) throw new Error(`no contract call for ${op.operation}`);
      const before = exchanges.length;
      const result = await call();
      const pattern = new RegExp(`^${op.path.replace(/\{id\}/g, "[^/?]+")}(\\?|$)`);
      const ex = exchanges.slice(before).find((e) => e.method === op.method && pattern.test(e.url));
      if (!ex) throw new Error(`no exchange recorded for ${op.operation}`);
      const schemas = CONTRACT_SCHEMAS[op.operation] ?? {};
      const query = Object.fromEntries(new URL(ex.url, "http://x").searchParams);
      const fixture: ContractFixture = {
        ...op,
        request: {
          url: ex.url,
          ...(Object.keys(query).length > 0 ? { query } : {}),
          ...(ex.body !== undefined ? { body: ex.body } : {}),
          headers: ex.headers,
        },
        response: {
          status: ex.status,
          contentType: ex.contentType,
          ...(ex.contentType.startsWith("text/event-stream") ? { body: result } : {}),
          ...(ex.json !== undefined ? { body: ex.json } : {}),
          ...(ex.bytes !== undefined ? { bodyBase64: toBase64(ex.bytes) } : {}),
          ...(ex.artifactHash !== undefined
            ? { headers: { "x-artifact-hash": ex.artifactHash } }
            : {}),
        },
        schemas: {
          ...(schemas.request ? { request: toJsonSchema(schemas.request, "input") } : {}),
          ...(schemas.response ? { response: toJsonSchema(schemas.response, "output") } : {}),
        },
      };
      const file = fileFor(op.operation);
      out.set(file, normalize(fixture));
      index.push({ operation: op.operation, file, status: op.status });
    }

    // Error envelope examples (every non-2xx reply has this shape).
    const errorExamples: { case: string; status: number; body: unknown }[] = [];
    for (const [name, run] of [
      ["not_found", () => client.missions.get(newId("msn"))],
      [
        "validation_failed",
        () => client.missions.create({ projectId: "nope", objective: "" } as never),
      ],
      ["invalid_transition", () => client.tasks.requestPr(failed.id)],
    ] as const) {
      const before = exchanges.length;
      await (run as () => Promise<unknown>)().catch(() => undefined);
      const ex = exchanges.slice(before).at(-1)!;
      errorExamples.push({ case: name, status: ex.status, body: ex.json });
    }
    out.set(
      "errors.json",
      normalize({
        description: "Error replies: any non-2xx status carries this body.",
        schema: toJsonSchema(ApiErrorBodySchema, "output"),
        examples: errorExamples,
      }),
    );
    out.set("index.json", {
      description:
        "Mimir HTTP contract fixtures: one file per OpenAPI operation with a recorded request and response and their JSON Schemas. Ids and timestamps are placeholders.",
      protocolVersion: PROTOCOL_VERSION,
      protocolPackageVersion: PROTOCOL_PACKAGE_VERSION,
      operations: index,
      errors: "errors.json",
    });
    return out;
  } finally {
    await server.close();
  }
}
