import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FakeProvider, type CompleteRequest, type LlmProvider } from "@sindri/director";
import { FakeHarnessService, HarnessServiceError } from "@sindri/harnesses";
import { openKnowledge } from "@sindri/knowledge";
import { demoPlanResponder } from "../demo-plan-responder.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvedSpec, startFlow, type Flow } from "./flow.js";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let f: Flow | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await h?.close();
  await f?.close();
  h = undefined;
  f = undefined;
});

const TASK = { id: "t1", title: "Add CSV export", description: "Export reports" };

const project = async (hh: Harness, repoPath = hh.repoDir) =>
  (await hh.call({ method: "POST", url: "/v1/projects", payload: { name: "P", repoPath } })).json()
    .project.id as string;

describe("projects", () => {
  it("refuses to bootstrap a project whose directory is gone", async () => {
    const hh = (h = await makeHarness());
    const dir = mkdtempSync(join(tmpdir(), "sindri-gone-"));
    const id = await project(hh, dir);
    rmSync(dir, { recursive: true });
    const res = await hh.call({ method: "POST", url: `/v1/projects/${id}/bootstrap`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "invalid_state",
      message: "the project repoPath no longer exists",
    });
  });

  it("refuses a directory inside the data directory and searches with a limit", async () => {
    const hh = (h = await makeHarness());
    const inside = await hh.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "P", repoPath: join(hh.dir) },
    });
    expect(inside.statusCode).toBe(422);
    const id = await project(hh);
    const res = await hh.call({ url: `/v1/projects/${id}/search?q=x&limit=3` });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toEqual([]);
    expect((await hh.call({ url: `/v1/projects/${id}/search?q=x&limit=0` })).statusCode).toBe(422);
  });
});

describe("specs and the director", () => {
  it("refuses an intake of another project and lists specs of known projects only", async () => {
    const hh = (h = await makeHarness());
    const a = await project(hh);
    const other = mkdtempSync(join(tmpdir(), "sindri-other-"));
    try {
      const b = await project(hh, other);
      const intake = (
        await hh.call({
          method: "POST",
          url: "/v1/intakes",
          payload: { projectId: b, title: "T", body: "B" },
        })
      ).json().intake.id as string;
      const res = await hh.call({
        method: "POST",
        url: "/v1/director/draft",
        payload: { projectId: a, intakeId: intake, request: "do it" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe("intake not found");
      const unknownIntake = await hh.call({
        method: "POST",
        url: "/v1/director/draft",
        payload: { projectId: a, intakeId: "int_nope", request: "do it" },
      });
      expect(unknownIntake.statusCode).toBe(404);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const missing = await hh.call({ url: "/v1/specs?projectId=prj_nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("project not found");
  });

  it("revises only the title, leaving the body as it was", async () => {
    const ff = (f = await startFlow());
    const specId = await approvedSpec(ff);
    const before = (await ff.h.call({ url: `/v1/specs/${specId}` })).json().spec;
    const res = await ff.h.call({
      method: "POST",
      url: `/v1/specs/${specId}/revise`,
      payload: { title: "Renamed" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec).toMatchObject({ title: "Renamed", version: before.version + 1 });
    expect(res.json().spec.body).toEqual(before.body);
  });
});

describe("plans", () => {
  it("needs a known spec or project to list plans, and one of them", async () => {
    const hh = (h = await makeHarness());
    const bySpec = await hh.call({ url: "/v1/plans?specId=spc_nope" });
    expect(bySpec.statusCode).toBe(404);
    expect(bySpec.json().error.message).toBe("specification not found");
    expect((await hh.call({ url: "/v1/plans?projectId=prj_nope" })).statusCode).toBe(404);
    const neither = await hh.call({ url: "/v1/plans" });
    expect(neither.statusCode).toBe(422);
    expect(neither.json().error.message).toBe("projectId or specId is required");
    expect(
      (await hh.call({ method: "POST", url: "/v1/plans/propose", payload: { specId: "x" } }))
        .statusCode,
    ).toBe(404);
  });
});

describe("plans: the workspace a planner reads", () => {
  it("plans a rework from a snapshot of the delivered commit, for a provider that reads files", async () => {
    const fake = new FakeProvider(demoPlanResponder());
    const reader: LlmProvider = {
      name: "fake",
      readsWorkspace: true,
      complete: (req) => fake.complete(req),
    };
    const ff = (f = await startFlow({ providerFactory: () => reader }));
    const specId = await approvedSpec(ff);
    const spec = (await ff.h.call({ url: `/v1/specs/${specId}` })).json().spec;
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: ff.repo.path,
        encoding: "utf8",
      }).trim();
    git("add", "-A");
    git("commit", "-q", "-m", "delivered");
    const head = git("rev-parse", "HEAD");
    // The spec is the draft of a rework of a delivery whose result is that commit.
    ff.h.db
      .prepare(
        `INSERT INTO rework_requests (id, project_id, source_execution_id, spec_lineage_id,
           base_commits_json, feedback, created_at) VALUES ('rwk_1', ?, 'exe_1', ?, ?, 'f', 'now')`,
      )
      .run(ff.projectId, spec.lineageId, JSON.stringify([head, "d".repeat(40)]));
    const res = await ff.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    expect(res.statusCode).toBe(201);
    const planning = fake.calls.filter((c: CompleteRequest) => c.metadata?.purpose === "plan");
    expect(planning.at(-1)).toMatchObject({
      workspace: join(ff.h.dir, "snapshots", ff.projectId, head),
      workspaceLabel: expect.stringContaining(
        `already delivered change at commit ${head.slice(0, 12)}`,
      ),
    });
    expect(planning.at(-1)!.workspaceLabel).toContain("1 other delivered commit(s)");
  });
});

describe("harnesses", () => {
  it("refuses an unknown project for repo signals and explanations", async () => {
    const hh = (h = await makeHarness());
    expect(
      (await hh.call({ url: "/v1/harnesses/repo-signals?projectId=prj_nope" })).statusCode,
    ).toBe(404);
    const explain = await hh.call({
      method: "POST",
      url: "/v1/harnesses/explain",
      payload: { projectId: "prj_nope", task: TASK },
    });
    expect(explain.statusCode).toBe(404);
  });

  it("refuses both a profile and a harness list", async () => {
    const hh = (h = await makeHarness());
    const res = await hh.call({
      method: "POST",
      url: "/v1/harnesses/explain",
      payload: {
        task: TASK,
        profile: "default",
        harnesses: [{ name: "a", version: "1.0.0" }],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("passes the profile or harness list on, and maps resolve failures by code", async () => {
    const service = new FakeHarnessService();
    const resolve = vi.spyOn(service, "resolve");
    const hh = (h = await makeHarness({ harnessService: service }));
    const explain = (payload: Record<string, unknown>) =>
      hh.call({
        method: "POST",
        url: "/v1/harnesses/explain",
        payload: { task: TASK, ...payload },
      });
    resolve.mockRejectedValueOnce(new HarnessServiceError("invalid_request", "no such profile x"));
    const invalid = await explain({ profile: "x" });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.message).toBe("no such profile x");
    expect(resolve).toHaveBeenLastCalledWith({ task: TASK, profile: "x" });

    resolve.mockRejectedValueOnce(new HarnessServiceError("not_found", "gone"));
    const harnesses = [{ name: "a", version: "1.0.0" }];
    const notFound = await explain({ harnesses });
    expect(notFound.statusCode).toBe(404);
    expect(resolve).toHaveBeenLastCalledWith({ task: TASK, harnesses });
  });
});

describe("knowledge", () => {
  it("labels URL sources, refuses an unknown project, and retracts once", async () => {
    const hh = (h = await makeHarness());
    const id = await project(hh);
    expect((await hh.call({ url: "/v1/knowledge?projectId=prj_nope" })).statusCode).toBe(404);
    const added = await hh.call({
      method: "POST",
      url: "/v1/knowledge",
      payload: {
        projectId: id,
        claim: "Docs live on the wiki",
        sourceRefs: [{ url: "https://wiki.example/docs" }],
        confidence: 0.7,
      },
    });
    expect(added.statusCode).toBe(201);
    const entry = added.json().entry;
    expect(entry.sources).toEqual([
      { ref: { url: "https://wiki.example/docs" }, label: "https://wiki.example/docs" },
    ]);
    const retract = (reason: string) =>
      hh.call({ method: "POST", url: `/v1/knowledge/${entry.id}/retract`, payload: { reason } });
    expect((await retract("outdated")).statusCode).toBe(200);
    const again = await retract("again");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("entry is already retracted");
    expect((await hh.call({ url: "/v1/knowledge/kn_nope/history" })).statusCode).toBe(404);
  });

  it("labels a task evidence source by its id", async () => {
    const hh = (h = await makeHarness());
    const id = await project(hh);
    const evidence = openKnowledge(hh.db).evidence.record({
      projectId: id,
      externalRef: "mimir:task:tsk_1",
      kind: "test.output",
      payload: { passed: true },
    });
    const added = await hh.call({
      method: "POST",
      url: "/v1/knowledge",
      payload: {
        projectId: id,
        claim: "Tests pass",
        sourceRefs: [{ taskEvidenceId: evidence.id }],
        confidence: 0.9,
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().entry.sources).toEqual([
      { ref: { taskEvidenceId: evidence.id }, label: `evidence:${evidence.id}` },
    ]);
  });
});
