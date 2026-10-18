import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AgentSchema,
  ApprovalSchema,
  ArtifactSchema,
  AuditEntrySchema,
  BudgetSchema,
  CommandSchema,
  CrewMemberSchema,
  CrewSchema,
  MissionSchema,
  PolicySchema,
  ProjectSchema,
  TaskDependencySchema,
  TaskSchema,
  UsageSampleSchema,
  WorktreeSchema,
} from "./entities.js";
import { newId } from "./ids.js";

const now = "2026-10-14T08:00:00.000Z";
const base = (prefix: Parameters<typeof newId>[0]) => ({
  id: newId(prefix),
  createdAt: now,
  updatedAt: now,
  version: 1,
});
const projectId = newId("prj");
const missionId = newId("msn");
const crewId = newId("crw");
const taskId = newId("tsk");
const agentId = newId("agt");

const samples: Array<[string, z.ZodType, Record<string, unknown>]> = [
  [
    "Project",
    ProjectSchema,
    { ...base("prj"), name: "mimir", repoPath: "/repo", settings: { defaultBranch: "main" } },
  ],
  ["Mission", MissionSchema, { ...base("msn"), projectId, objective: "Ship it", status: "draft" }],
  [
    "Crew",
    CrewSchema,
    {
      ...base("crw"),
      missionId,
      template: "default",
      status: "configured",
      limits: { maxAgents: 3, maxConcurrentTasks: 2 },
    },
  ],
  [
    "CrewMember",
    CrewMemberSchema,
    { ...base("cmb"), crewId, role: "implementer", agentKind: "claude", name: "impl-1" },
  ],
  [
    "Task",
    TaskSchema,
    {
      ...base("tsk"),
      missionId,
      crewId,
      title: "Write protocol",
      acceptance: "tests pass",
      status: "pending",
      attempt: 0,
      maxAttempts: 3,
      agentId: null,
      leaseExpiresAt: null,
    },
  ],
  ["TaskDependency", TaskDependencySchema, { ...base("tdp"), taskId, dependsOnId: newId("tsk") }],
  [
    "Agent",
    AgentSchema,
    {
      ...base("agt"),
      crewId,
      role: "reviewer",
      agentKind: "codex",
      runtimeSessionId: newId("ses"),
      status: "idle",
      taskId: null,
    },
  ],
  [
    "Worktree",
    WorktreeSchema,
    {
      ...base("wtr"),
      taskId,
      path: "/repo/.mimir/wt/1",
      branch: "mimir/task-1",
      baseSha: "a".repeat(40),
      status: "active",
    },
  ],
  [
    "Command",
    CommandSchema,
    {
      ...base("cmd"),
      idempotencyKey: "k-1",
      type: "mission.start",
      status: "accepted",
      payload: { missionId },
      requestHash: "sha256:abc",
      operationId: newId("op"),
    },
  ],
  [
    "Artifact",
    ArtifactSchema,
    { ...base("art"), taskId, kind: "log", uri: "file:///tmp/a.log", hash: "sha256:abc" },
  ],
  [
    "Approval",
    ApprovalSchema,
    {
      ...base("apr"),
      action: "git.push",
      status: "pending",
      actor: null,
      expiry: "2026-10-14T09:00:00Z",
      missionId,
      taskId,
      reason: null,
    },
  ],
  [
    "Policy",
    PolicySchema,
    {
      ...base("pol"),
      projectId,
      name: "protect main",
      rules: [{ action: "git.push", effect: "require_approval" }],
    },
  ],
  [
    "Budget",
    BudgetSchema,
    {
      ...base("bgt"),
      missionId,
      crewId: null,
      limitTokens: 1_000_000,
      limitCost: 25,
      warnAtFraction: 0.8,
    },
  ],
  [
    "UsageSample",
    UsageSampleSchema,
    { ...base("usg"), agentId, tokens: 1200, estimatedCost: 0.02, source: "estimated" },
  ],
  [
    "AuditEntry",
    AuditEntrySchema,
    {
      ...base("aud"),
      actor: "user:local",
      action: "approval.decided",
      targetType: "approval",
      targetId: newId("apr"),
      details: { decision: "approved" },
    },
  ],
];

describe("entities", () => {
  it.each(samples)("%s parses a valid sample", (_name, schema, sample) => {
    expect(schema.parse(sample)).toEqual(sample);
  });

  it.each(samples)("%s requires id, createdAt, updatedAt, version", (_name, schema, sample) => {
    for (const key of ["id", "createdAt", "updatedAt", "version"]) {
      const rest = { ...sample };
      delete rest[key];
      const r = schema.safeParse(rest);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual([key]);
    }
  });

  it("Task.blockedReason is optional and round-trips", () => {
    const task = samples.find(([n]) => n === "Task")![2];
    expect("blockedReason" in TaskSchema.parse(task)).toBe(false);
    const blocked = { ...task, status: "blocked", blockedReason: "budget_exceeded" };
    expect(TaskSchema.parse(blocked)).toEqual(blocked);
  });

  it("rejects bad fields at the right path", () => {
    const task = samples.find(([n]) => n === "Task")![2];
    const badStatus = TaskSchema.safeParse({ ...task, status: "done" });
    expect(badStatus.error?.issues[0]?.path).toEqual(["status"]);

    const badAttempt = TaskSchema.safeParse({ ...task, attempt: -1 });
    expect(badAttempt.error?.issues[0]?.path).toEqual(["attempt"]);

    const badReason = TaskSchema.safeParse({ ...task, status: "blocked", blockedReason: 42 });
    expect(badReason.error?.issues[0]?.path).toEqual(["blockedReason"]);

    const mission = samples.find(([n]) => n === "Mission")![2];
    const badProject = MissionSchema.safeParse({ ...mission, projectId: newId("msn") });
    expect(badProject.error?.issues[0]?.path).toEqual(["projectId"]);

    const badTime = MissionSchema.safeParse({ ...mission, createdAt: "yesterday" });
    expect(badTime.error?.issues[0]?.path).toEqual(["createdAt"]);

    const crew = samples.find(([n]) => n === "Crew")![2];
    const badLimits = CrewSchema.safeParse({ ...crew, limits: { maxAgents: 0 } });
    expect(badLimits.error?.issues[0]?.path).toEqual(["limits", "maxAgents"]);

    const usage = samples.find(([n]) => n === "UsageSample")![2];
    const badSource = UsageSampleSchema.safeParse({ ...usage, source: "guessed" });
    expect(badSource.error?.issues[0]?.path).toEqual(["source"]);

    const policy = samples.find(([n]) => n === "Policy")![2];
    const badRule = PolicySchema.safeParse({
      ...policy,
      rules: [{ action: "git.push", effect: "maybe" }],
    });
    expect(badRule.error?.issues[0]?.path).toEqual(["rules", 0, "effect"]);
  });
});
