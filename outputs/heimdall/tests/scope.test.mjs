// The project filter behind every top-bar page: what the selection includes, crew counts that
// match Mimir's, notifications per project, and the attention list with budget blocks.
import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionItems,
  blockedText,
  crewCounts,
  isBudgetBlocked,
  liveAgentOf,
  scopeOf,
  scopedNotifications,
} from "../apps/web/src/features/scope.ts";
import { parseRoute, hrefFor } from "../apps/web/src/lib/router.ts";

const state = {
  preferences: { archivedProjects: ["prj_old"] },
  mimir: {
    projects: [
      { id: "prj_a", name: "a", repoPath: "/r/a" },
      { id: "prj_b", name: "b", repoPath: "/r/b" },
      { id: "prj_old", name: "old", repoPath: "/r/old" },
    ],
    missions: [
      { id: "m_a", projectId: "prj_a" },
      { id: "m_b", projectId: "prj_b" },
    ],
    crews: [
      { id: "c_a1", missionId: "m_a", status: "configured" },
      { id: "c_a2", missionId: "m_a", status: "configured" },
      { id: "c_b", missionId: "m_b", status: "configured" },
    ],
    tasks: [
      {
        id: "t_a",
        missionId: "m_a",
        crewId: "c_a1",
        status: "running",
        agentId: "g_a",
      },
      {
        id: "t_budget",
        missionId: "m_a",
        crewId: "c_a2",
        status: "blocked",
        blockedReason: "budget_exceeded",
        title: "Docs",
      },
      { id: "t_b", missionId: "m_b", crewId: "c_b", status: "failed" },
    ],
    agents: [
      {
        id: "g_a",
        crewId: "c_a1",
        taskId: "t_a",
        status: "running",
        runtimeSessionId: "s1",
      },
      { id: "g_b", crewId: "c_b", status: "idle" },
    ],
    approvals: [{ id: "ap", missionId: "m_b", status: "pending" }],
  },
  sindri: {
    projects: [{ id: "sp_a", name: "a", repoPath: "/r/a" }],
    specs: [{ id: "s1", projectId: "sp_a", status: "review", version: 1 }],
    plans: [],
    intakes: [],
    deliveries: [],
    executions: [],
  },
};

test("a selected project narrows missions, crews, agents, Sindri records and approvals", () => {
  const a = scopeOf(state, "/r/a");
  assert.equal(a.filter, "/r/a");
  assert.deepEqual(
    a.projects.map((p) => p.id),
    ["prj_a"],
  );
  assert.deepEqual(
    a.crews.map((c) => c.id),
    ["c_a1", "c_a2"],
  );
  assert.deepEqual(
    a.agents.map((x) => x.id),
    ["g_a"],
  );
  assert.deepEqual(
    a.specs.map((x) => x.id),
    ["s1"],
    "Sindri's record of the same repository counts",
  );
  assert.equal(a.approvals.length, 0);
  assert.equal(a.includes({ taskId: "t_b" }), false);
  assert.equal(
    a.includes({}),
    false,
    "records without an owner only show for all projects",
  );
});

test("all projects, unknown and archived selections fall back to everything active", () => {
  for (const selection of ["all", "/r/missing", "/r/old"]) {
    const s = scopeOf(state, selection);
    assert.equal(s.filter, "all", selection);
    assert.deepEqual(
      s.projects.map((p) => p.id),
      ["prj_a", "prj_b"],
    );
  }
  assert.equal(
    scopeOf(null, "all").tasks.length,
    0,
    "no snapshot yet is an empty scope",
  );
});

test("crew counts list every crew Mimir has, with the working ones apart", () => {
  assert.deepEqual(crewCounts(scopeOf(state, "/r/a")), {
    crews: 2,
    workingCrews: 1,
    agents: 1,
    workingAgents: 1,
  });
  assert.deepEqual(crewCounts(scopeOf(state, "all")), {
    crews: 3,
    workingCrews: 1,
    agents: 2,
    workingAgents: 1,
  });
});

test("connection notices belong to all projects only", () => {
  const notes = [
    { id: "1", kind: "connection", row: { id: "mimir" } },
    { id: "2", kind: "tasks", resourceId: "t_b" },
    { id: "3", kind: "tasks", resourceId: "t_a" },
  ];
  assert.deepEqual(
    scopedNotifications(notes, scopeOf(state, "/r/a")).map((n) => n.id),
    ["3"],
  );
  assert.deepEqual(
    scopedNotifications(notes, scopeOf(state, "all")).map((n) => n.id),
    ["1", "2", "3"],
  );
});

test("budget-blocked tasks are their own attention kind; unknown reasons stay as sent", () => {
  const items = attentionItems(scopeOf(state, "all"), () => "run");
  assert.deepEqual(
    items.map((i) => i.kind),
    ["approval", "budget", "failed", "review"],
  );
  assert.equal(
    isBudgetBlocked({ status: "blocked", blockedReason: "budget_uncertain" }),
    true,
  );
  assert.equal(
    isBudgetBlocked({ status: "ready", blockedReason: "budget_exceeded" }),
    false,
  );
  assert.equal(blockedText("budget_exceeded"), "Crew budget used up");
  assert.equal(
    blockedText("waiting_on_lunar_eclipse"),
    "waiting_on_lunar_eclipse",
  );
});

test("tasks of a cancelled or finished mission need no one", () => {
  const all = scopeOf(state, "all");
  const failed = all.tasks.find((t) => t.status === "failed");
  assert.ok(failed, "fixture has a failed task");
  const ended = {
    ...all,
    missions: all.missions.map((m) =>
      m.id === failed.missionId ? { ...m, status: "cancelled" } : m,
    ),
  };
  const kinds = attentionItems(ended, () => "run").map((i) => i.id);
  assert.equal(kinds.includes("failed:" + failed.id), false);
  assert.equal(
    attentionItems(all, () => "run").some(
      (i) => i.id === "failed:" + failed.id,
    ),
    true,
  );
});

test("only a running agent with a session can be watched live", () => {
  const all = scopeOf(state, "all");
  assert.equal(
    liveAgentOf({ id: "t_a", agentId: "g_a" }, all.agents)?.id,
    "g_a",
  );
  assert.equal(liveAgentOf({ id: "t_b" }, all.agents), undefined);
});

test("routes: every page has a path, old links still land, the project rides along", () => {
  assert.equal(parseRoute("/pipeline", "?project=prj_a").page, "pipeline");
  assert.equal(parseRoute("/autonomy/all", "").page, "autonomy-all");
  assert.deepEqual(
    [
      parseRoute("/connections/access", "").page,
      parseRoute("/connections/access", "").sub,
    ],
    ["connections", "access"],
  );
  assert.equal(parseRoute("/docs/glossary", "").sub, "glossary");
  assert.equal(parseRoute("/", "?view=fleet").page, "fleet");
  assert.equal(
    parseRoute("/", "?task=tsk_1").params.get("inspect"),
    "tasks:tsk_1",
  );
  assert.equal(parseRoute("/no-such-page", "").page, "overview");
  assert.equal(
    hrefFor("crews-agents", { project: "prj_a", empty: "" }),
    "/crews?project=prj_a",
  );
  assert.equal(hrefFor("overview"), "/");
  assert.equal(hrefFor("connections", {}, "audit"), "/connections/audit");
});

test("the app switcher links to the other apps' landing pages without Heimdall's project ID", async () => {
  const { switcherApps } = await import("../apps/web/src/lib/apps.ts");
  const links = Object.fromEntries(
    switcherApps("/?project=prj_a").map((a) => [a.id, a.href]),
  );
  assert.deepEqual(links, {
    sindri: "http://127.0.0.1:4310/#/overview",
    heimdall: "/?project=prj_a",
    mimir: "http://127.0.0.1:7700/",
  });
});
