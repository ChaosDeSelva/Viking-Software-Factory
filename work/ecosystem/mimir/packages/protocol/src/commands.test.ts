import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ApprovalDecisionRequestSchema,
  CancelMissionRequestSchema,
  CapabilitiesResponseSchema,
  CreateCrewRequestSchema,
  CreateMissionRequestSchema,
  CreateMissionResponseSchema,
  CreateProjectRequestSchema,
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  HealthResponseSchema,
  IDEMPOTENCY_HEADER,
  ListEventsQuerySchema,
  ListEventsResponseSchema,
  OperationAcceptedSchema,
  RequestPrRequestSchema,
  RequestPrResponseSchema,
  RetryTaskRequestSchema,
  SendInstructionRequestSchema,
  SnapshotResponseSchema,
  StartMissionRequestSchema,
  StopSessionRequestSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  type ListEventsQuery,
  type ListEventsQueryInput,
  type ListEventsQueryParsed,
  type RequestPrResponse,
} from "./commands.js";
import type { EventType } from "./events.js";
import { ProjectSettingsSchema } from "./entities.js";
import { newId } from "./ids.js";
import { PROTOCOL_VERSION } from "./version.js";

const now = "2026-10-14T08:00:00.000Z";
const path = (r: { error?: { issues: { path: PropertyKey[] }[] } }) => r.error?.issues[0]?.path;

describe("constants", () => {
  it("exposes the idempotency header and protocol version", () => {
    expect(IDEMPOTENCY_HEADER).toBe("idempotency-key");
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("mutation requests", () => {
  it("CreateMissionRequest", () => {
    const ok = { projectId: newId("prj"), objective: "Ship M02" };
    expect(CreateMissionRequestSchema.parse(ok)).toEqual(ok);
    expect(path(CreateMissionRequestSchema.safeParse({ ...ok, objective: "" }))).toEqual([
      "objective",
    ]);
    expect(path(CreateMissionRequestSchema.safeParse({ ...ok, projectId: "x" }))).toEqual([
      "projectId",
    ]);
  });

  it("CreateMissionResponse wraps a mission", () => {
    const mission = {
      id: newId("msn"),
      createdAt: now,
      updatedAt: now,
      version: 0,
      projectId: newId("prj"),
      objective: "o",
      status: "draft",
    };
    expect(CreateMissionResponseSchema.parse({ mission })).toEqual({ mission });
    expect(
      path(CreateMissionResponseSchema.safeParse({ mission: { ...mission, status: "x" } })),
    ).toEqual(["mission", "status"]);
  });

  it("Start/Cancel/Retry accept empty bodies and optional fields", () => {
    expect(StartMissionRequestSchema.parse({})).toEqual({});
    expect(StartMissionRequestSchema.parse({ expectedVersion: 3 })).toEqual({ expectedVersion: 3 });
    expect(path(StartMissionRequestSchema.safeParse({ expectedVersion: -1 }))).toEqual([
      "expectedVersion",
    ]);
    expect(CancelMissionRequestSchema.parse({ reason: "stop" })).toEqual({ reason: "stop" });
    expect(RetryTaskRequestSchema.parse({})).toEqual({});
    expect(RetryTaskRequestSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it.each([
    [
      "CreateMissionRequest",
      CreateMissionRequestSchema,
      { projectId: newId("prj"), objective: "o" },
    ],
    ["StartMissionRequest", StartMissionRequestSchema, {}],
    ["CancelMissionRequest", CancelMissionRequestSchema, {}],
    ["RetryTaskRequest", RetryTaskRequestSchema, {}],
    ["ApprovalDecisionRequest", ApprovalDecisionRequestSchema, { decision: "approved" }],
    ["CreateProjectRequest", CreateProjectRequestSchema, { name: "n", repoPath: "/r" }],
    [
      "CreateCrewRequest",
      CreateCrewRequestSchema,
      { missionId: newId("msn"), template: "t", members: [{ role: "qa", agentKind: "c" }] },
    ],
    ["SendInstructionRequest", SendInstructionRequestSchema, { text: "go" }],
    ["StopSessionRequest", StopSessionRequestSchema, { mode: "force" }],
  ] as const)("%s rejects unknown keys", (_name, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    const r = schema.safeParse({ ...valid, extra: 1 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("ApprovalDecisionRequest", () => {
    expect(ApprovalDecisionRequestSchema.parse({ decision: "approved" })).toEqual({
      decision: "approved",
    });
    expect(ApprovalDecisionRequestSchema.parse({ decision: "rejected", reason: "unsafe" })).toEqual(
      { decision: "rejected", reason: "unsafe" },
    );
    expect(path(ApprovalDecisionRequestSchema.safeParse({ decision: "expired" }))).toEqual([
      "decision",
    ]);
  });

  it("CreateProjectRequest and CreateCrewRequest", () => {
    expect(CreateProjectRequestSchema.parse({ name: "m", repoPath: "/r" })).toEqual({
      name: "m",
      repoPath: "/r",
    });
    expect(path(CreateProjectRequestSchema.safeParse({ name: "m" }))).toEqual(["repoPath"]);
    const crew = {
      missionId: newId("msn"),
      template: "default",
      members: [{ role: "lead", agentKind: "claude" }],
    };
    expect(CreateCrewRequestSchema.parse(crew)).toEqual(crew);
    expect(
      path(
        CreateCrewRequestSchema.safeParse({ ...crew, members: [{ role: "boss", agentKind: "c" }] }),
      ),
    ).toEqual(["members", 0, "role"]);
  });

  it("SendInstructionRequest and StopSessionRequest", () => {
    expect(SendInstructionRequestSchema.parse({ text: "go" })).toEqual({ text: "go" });
    expect(path(SendInstructionRequestSchema.safeParse({ text: "" }))).toEqual(["text"]);
    expect(StopSessionRequestSchema.parse({ mode: "soft" })).toEqual({ mode: "soft" });
    expect(path(StopSessionRequestSchema.safeParse({ mode: "kill" }))).toEqual(["mode"]);
  });

  it("CreateMissionRequest and CreateCrewRequest accept an optional budget", () => {
    const budget = { limitTokens: 1000, warnAtFraction: 0.8, enforce: "soft", onUnknown: "allow" };
    const mission = { projectId: newId("prj"), objective: "o", budget };
    expect(CreateMissionRequestSchema.parse(mission)).toEqual(mission);
    expect(
      path(CreateMissionRequestSchema.safeParse({ ...mission, budget: { limitTokens: -1 } })),
    ).toEqual(["budget", "limitTokens"]);
    const crew = {
      missionId: newId("msn"),
      template: "solo",
      members: [{ role: "implementer", agentKind: "shell" }],
      budget: { limitCost: 2.5 },
    };
    expect(CreateCrewRequestSchema.parse(crew)).toEqual(crew);
  });

  it("CreateProjectRequest.settings: testCommand is argv only; allowedCommands are allowlist entries", () => {
    const base = { name: "p", repoPath: "/r" };
    const ok = {
      ...base,
      settings: {
        testCommand: ["npm", "test"],
        protectedBranches: ["main"],
        allowedCommands: [
          { argv0: "make", args: { exact: ["test"] } },
          { argv0: "ls", args: "none" },
          {
            argv0: "cat",
            args: { shape: { maxArgs: 2, pathArgsMustBeInsideWorktreeAndNonSensitive: true } },
          },
        ],
        other: { anything: true },
      },
    };
    expect(CreateProjectRequestSchema.parse(ok)).toEqual(ok);
    expect(
      path(
        CreateProjectRequestSchema.safeParse({ ...base, settings: { testCommand: "npm test" } }),
      ),
    ).toEqual(["settings", "testCommand"]);
    expect(
      path(CreateProjectRequestSchema.safeParse({ ...base, settings: { testCommand: [] } })),
    ).toEqual(["settings", "testCommand"]);
    expect(
      path(
        CreateProjectRequestSchema.safeParse({
          ...base,
          settings: { allowedCommands: [{ argv0: "", args: "none" }] },
        }),
      ),
    ).toEqual(["settings", "allowedCommands", 0, "argv0"]);
    expect(ProjectSettingsSchema.parse({})).toEqual({});
  });

  it("ProjectSettings.verification is an opaque verifier configuration object (T12b)", () => {
    const verification = { harnesses: ["documentation@^1"], lockPath: "/x/lock.json" };
    expect(ProjectSettingsSchema.parse({ verification })).toEqual({ verification });
    expect(ProjectSettingsSchema.safeParse({ verification: "brokkr" }).success).toBe(false);
    expect(ProjectSettingsSchema.safeParse({ verification: ["x"] }).success).toBe(false);
  });

  it("CreateTaskRequest and CreateTaskResponse", () => {
    const req = {
      missionId: newId("msn"),
      title: "Build it",
      brief: "echo build",
      acceptanceCriteria: ["builds"],
      dependsOn: [newId("tsk")],
      argv: ["sh", "-c", "make"],
    };
    expect(CreateTaskRequestSchema.parse(req)).toEqual(req);
    expect(path(CreateTaskRequestSchema.safeParse({ ...req, title: "" }))).toEqual(["title"]);
    expect(path(CreateTaskRequestSchema.safeParse({ ...req, brief: undefined }))).toEqual([
      "brief",
    ]);
    expect(path(CreateTaskRequestSchema.safeParse({ ...req, dependsOn: ["x"] }))).toEqual([
      "dependsOn",
      0,
    ]);
    expect(path(CreateTaskRequestSchema.safeParse({ ...req, argv: [] }))).toEqual(["argv"]);
    expect(path(CreateTaskRequestSchema.safeParse({ ...req, extra: 1 }))).toEqual([]);
    const task = {
      id: newId("tsk"),
      missionId: req.missionId,
      crewId: null,
      title: "Build it",
      acceptance: "",
      status: "pending",
      attempt: 0,
      maxAttempts: 3,
      agentId: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    expect(CreateTaskResponseSchema.parse({ task })).toEqual({ task });
  });

  it("CreateMissionRequest accepts its task DAG; the response may list the created tasks", () => {
    const a = newId("tsk");
    const mission = {
      projectId: newId("prj"),
      objective: "o",
      tasks: [
        { id: a, title: "A", brief: "echo A" },
        { title: "B", brief: "echo B", dependsOn: [a], acceptanceCriteria: ["b works"] },
        { title: "C", brief: "rm -rf build", argv: ["sh", "-c", "rm -rf build"] },
      ],
    };
    expect(CreateMissionRequestSchema.parse(mission)).toEqual(mission);
    expect(
      path(CreateMissionRequestSchema.safeParse({ ...mission, tasks: [{ title: "x" }] })),
    ).toEqual(["tasks", 0, "brief"]);
    expect(
      path(
        CreateMissionRequestSchema.safeParse({
          ...mission,
          tasks: [{ id: "a", title: "x", brief: "y" }],
        }),
      ),
    ).toEqual(["tasks", 0, "id"]);
    const created = CreateMissionResponseSchema.parse({
      mission: {
        id: newId("msn"),
        projectId: mission.projectId,
        objective: "o",
        status: "draft",
        createdAt: now,
        updatedAt: now,
        version: 0,
      },
      tasks: [],
    });
    expect(created.tasks).toEqual([]);
  });

  it("UsageQuery filters by crew and project; UsageResponse may flag uncertainty", () => {
    const q = { crewId: newId("crw"), projectId: newId("prj") };
    expect(UsageQuerySchema.parse(q)).toEqual(q);
    const totals = {
      tokens: 0,
      estimatedCost: 0,
      samples: 1,
      bySource: { measured: 0, estimated: 0, unavailable: 1 },
    };
    expect(UsageResponseSchema.parse({ totals, samples: [], uncertain: true })).toEqual({
      totals,
      samples: [],
      uncertain: true,
    });
  });

  it("OperationAccepted", () => {
    const ok = { operationId: newId("op"), commandId: newId("cmd") };
    expect(OperationAcceptedSchema.parse(ok)).toEqual(ok);
    expect(path(OperationAcceptedSchema.safeParse({ ...ok, commandId: "c" }))).toEqual([
      "commandId",
    ]);
  });
});

describe("events listing", () => {
  it("ListEventsQueryInput is the caller-facing shape (limit optional, types typed)", () => {
    expectTypeOf({}).toExtend<ListEventsQueryInput>();
    expectTypeOf({
      limit: 5,
      types: ["task.created"] as EventType[],
    }).toExtend<ListEventsQueryInput>();
    expectTypeOf<ListEventsQuery>().toEqualTypeOf<ListEventsQueryInput>();
    expectTypeOf<ListEventsQueryInput["types"]>().not.toBeUnknown();
    expectTypeOf<{ types: number[] }>().not.toExtend<ListEventsQueryInput>();
    expectTypeOf<{ limit: boolean }>().not.toExtend<ListEventsQueryInput>();
  });

  it("ListEventsQueryParsed is the server-side output shape", () => {
    expectTypeOf<ListEventsQueryParsed["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<ListEventsQueryParsed["types"]>().toEqualTypeOf<EventType[] | undefined>();
  });

  it("ListEventsQuery defaults limit to 200 and coerces query strings", () => {
    expect(ListEventsQuerySchema.parse({})).toEqual({ limit: 200 });
    expect(
      ListEventsQuerySchema.parse({ limit: "50", cursor: "c1", types: "task.ready,task.leased" }),
    ).toEqual({ limit: 50, cursor: "c1", types: ["task.ready", "task.leased"] });
    expect(ListEventsQuerySchema.parse({ types: ["session.output"] }).types).toEqual([
      "session.output",
    ]);
  });

  it("ListEventsQuery rejects out-of-range limits and unknown types", () => {
    expect(path(ListEventsQuerySchema.safeParse({ limit: 0 }))).toEqual(["limit"]);
    expect(path(ListEventsQuerySchema.safeParse({ limit: "1001" }))).toEqual(["limit"]);
    expect(path(ListEventsQuerySchema.safeParse({ limit: 2.5 }))).toEqual(["limit"]);
    expect(path(ListEventsQuerySchema.safeParse({ types: "task.ready,task.nope" }))).toEqual([
      "types",
      1,
    ]);
  });

  it("ListEventsResponse", () => {
    const event = {
      id: newId("evt"),
      schemaVersion: 1,
      streamId: "s",
      sequence: 0,
      occurredAt: now,
      observedAt: now,
      type: "task.ready",
      source: "mimir",
      provenance: "derived",
      payload: { from: "pending", to: "ready" },
    };
    expect(ListEventsResponseSchema.parse({ events: [event], nextCursor: null })).toEqual({
      events: [event],
      nextCursor: null,
    });
    expect(path(ListEventsResponseSchema.safeParse({ events: [] }))).toEqual(["nextCursor"]);
    const resumable = { events: [event], nextCursor: null, hasMore: false, lastCursor: "Mw==" };
    expect(ListEventsResponseSchema.parse(resumable)).toEqual(resumable);
    expect(path(ListEventsResponseSchema.safeParse({ ...resumable, hasMore: "no" }))).toEqual([
      "hasMore",
    ]);
  });
});

describe("read models", () => {
  it("SnapshotResponse", () => {
    const empty = {
      projects: [],
      missions: [],
      crews: [],
      tasks: [],
      taskDependencies: [],
      agents: [],
      approvals: [],
      worktrees: [],
      usage: {
        tokens: 0,
        estimatedCost: 0,
        samples: 0,
        bySource: { measured: 0, estimated: 0, unavailable: 0 },
      },
      cursor: "c0",
    };
    expect(SnapshotResponseSchema.parse(empty)).toEqual(empty);
    expect(path(SnapshotResponseSchema.safeParse({ ...empty, cursor: undefined }))).toEqual([
      "cursor",
    ]);
  });

  it("CapabilitiesResponse", () => {
    const ok = { serverVersion: "0.1.0", protocolVersion: 1, runtime: null };
    expect(CapabilitiesResponseSchema.parse(ok)).toEqual(ok);
    expect(path(CapabilitiesResponseSchema.safeParse({ ...ok, protocolVersion: 2 }))).toEqual([
      "protocolVersion",
    ]);
  });

  it("HealthResponse matches what the server already returns", () => {
    expect(HealthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(path(HealthResponseSchema.safeParse({ status: "meh" }))).toEqual(["status"]);
  });

  it("HealthResponse carries an optional store integrity summary (T14a fix I1)", () => {
    const degraded = {
      status: "degraded",
      integrity: { refusedRows: 2, firstRefusedAt: "2026-10-14T00:00:00.000Z" },
    };
    expect(HealthResponseSchema.parse(degraded)).toEqual(degraded);
    const clean = { status: "ok", integrity: { refusedRows: 0, firstRefusedAt: null } };
    expect(HealthResponseSchema.parse(clean)).toEqual(clean);
    expect(
      path(
        HealthResponseSchema.safeParse({
          status: "ok",
          integrity: { refusedRows: -1, firstRefusedAt: null },
        }),
      ),
    ).toEqual(["integrity", "refusedRows"]);
  });
});

describe("POST /v1/tasks/:id/pr (T12b)", () => {
  const base = { operationId: newId("op"), commandId: newId("cmd") };

  it("RequestPrRequest is an optional empty body (no title/body fields)", () => {
    expect(RequestPrRequestSchema.parse({})).toEqual({});
    expect(RequestPrRequestSchema.safeParse({ title: "x" }).success).toBe(false);
  });

  it("RequestPrResponse: approval_required carries the approval id", () => {
    const pending = { ...base, status: "approval_required", approvalId: newId("apr") };
    expect(RequestPrResponseSchema.parse(pending)).toEqual(pending);
    expect(
      path(RequestPrResponseSchema.safeParse({ ...base, status: "approval_required" })),
    ).toEqual(["approvalId"]);
  });

  it("RequestPrResponse: delivered may carry a PR URL", () => {
    const delivered = { ...base, status: "delivered" };
    expect(RequestPrResponseSchema.parse(delivered)).toEqual(delivered);
    const withUrl = { ...delivered, prUrl: "https://example.test/o/r/pull/1" };
    expect(RequestPrResponseSchema.parse(withUrl)).toEqual(withUrl);
    expect(RequestPrResponseSchema.safeParse({ ...delivered, prUrl: "not a url" }).success).toBe(
      false,
    );
    expect(RequestPrResponseSchema.safeParse({ ...base, status: "merged" }).success).toBe(false);
    expect(RequestPrResponseSchema.safeParse({ status: "delivered" }).success).toBe(false);
  });

  it("types", () => {
    expectTypeOf<RequestPrResponse["status"]>().toEqualTypeOf<"approval_required" | "delivered">();
  });
});
