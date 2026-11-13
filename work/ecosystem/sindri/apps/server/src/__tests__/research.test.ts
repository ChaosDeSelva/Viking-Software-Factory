import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFlow, type Flow } from "./flow.js";
import { startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

const DOC = [
  "## Answer",
  "Exports stream rows [1].",
  "## Findings",
  "The page lists invoices [1].",
  "## Open questions",
  "None.",
  "## Sources",
  "[1] https://example.com/exports",
].join("\n");
const SOURCES = JSON.stringify([{ id: "1", kind: "url", ref: "https://example.com/exports" }]);

let f: Flow | MimirFlow | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sindri-skills-route-"));
});
afterEach(async () => {
  await f?.close();
  f = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const skillFolder = (name: string, text: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), text);
  return join(dir, name);
};

/** Turns local-only mode on or off, keeping the other settings. */
async function setLocalOnly(flow: Flow, localOnly: boolean) {
  const st = (await flow.h.call({ url: "/v1/settings" })).json().settings;
  const put = await flow.h.call({
    method: "PUT",
    url: "/v1/settings",
    payload: { ...st, localOnly },
  });
  expect(put.statusCode).toBe(200);
}

describe("skills library and project guidance routes", () => {
  it("imports, lists, previews, re-imports and deletes skills", async () => {
    const flow = (f = await startFlow());
    const folder = skillFolder(
      "careful",
      "---\nname: careful\ndescription: Be careful\n---\nBody\n",
    );
    const imp = await flow.h.call({ method: "POST", url: "/v1/skills", payload: { path: folder } });
    expect(imp.statusCode).toBe(201);
    const skill = imp.json().imported[0];
    expect(skill).toMatchObject({ name: "careful", description: "Be careful" });
    expect(skill.content).toBeUndefined();

    let list = (await flow.h.call({ url: "/v1/skills" })).json().skills;
    expect(list).toEqual([expect.objectContaining({ id: skill.id, changedOnDisk: false })]);
    writeFileSync(join(folder, "SKILL.md"), "changed\n");
    list = (await flow.h.call({ url: "/v1/skills" })).json().skills;
    expect(list[0].changedOnDisk).toBe(true);

    const re = await flow.h.call({
      method: "POST",
      url: `/v1/skills/${skill.id}/reimport`,
      payload: {},
    });
    expect(re.statusCode).toBe(200);
    expect(re.json().skill.digest).not.toBe(skill.digest);
    const one = (await flow.h.call({ url: `/v1/skills/${skill.id}` })).json().skill;
    expect(one).toMatchObject({ content: "changed\n", changedOnDisk: false });

    const bad = await flow.h.call({
      method: "POST",
      url: "/v1/skills",
      payload: { path: "relative/folder" },
    });
    expect(bad.statusCode).toBe(422);

    const del = await flow.h.call({ method: "DELETE", url: `/v1/skills/${skill.id}` });
    expect(del.statusCode).toBe(200);
    expect((await flow.h.call({ url: `/v1/skills/${skill.id}` })).statusCode).toBe(404);
  });

  it("reads and writes a project's guidance, refusing unknown skills", async () => {
    const flow = (f = await startFlow());
    const url = `/v1/projects/${flow.projectId}/guidance`;
    expect((await flow.h.call({ url })).json().guidance).toMatchObject({
      notes: "",
      defaultSkillIds: [],
    });
    const skill = (
      await flow.h.call({
        method: "POST",
        url: "/v1/skills",
        payload: { path: skillFolder("s", "S\n") },
      })
    ).json().imported[0];
    const put = await flow.h.call({
      method: "PUT",
      url,
      payload: { notes: "Prefer small diffs", defaultSkillIds: [skill.id] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().guidance).toMatchObject({
      notes: "Prefer small diffs",
      defaultSkillIds: [skill.id],
    });
    const unknown = await flow.h.call({
      method: "PUT",
      url,
      payload: { notes: "", defaultSkillIds: ["skl_nope"] },
    });
    expect(unknown.statusCode).toBe(422);
    expect((await flow.h.call({ url: "/v1/projects/nope/guidance" })).statusCode).toBe(404);
  });
});

describe("intake work kind", () => {
  it("creates a research intake with notes and skills, and refuses unknown skills", async () => {
    const flow = (f = await startFlow());
    await setLocalOnly(flow, false);
    const skill = (
      await flow.h.call({
        method: "POST",
        url: "/v1/skills",
        payload: { path: skillFolder("s", "S\n") },
      })
    ).json().imported[0];
    const res = await flow.h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: {
        projectId: flow.projectId,
        title: "How do exports work?",
        body: "",
        workKind: "research",
        notes: "Look at the reports page",
        skillIds: [skill.id],
        research: { sources: { web: true, feedbackGraph: false } },
      },
    });
    expect(res.statusCode).toBe(201);
    const intake = res.json().intake;
    expect(intake).toMatchObject({
      workKind: "research",
      notes: "Look at the reports page",
      skillIds: [skill.id],
      research: { sources: { code: true, feedbackGraph: false, web: true }, factCheck: true },
      linkedExecutionId: null,
    });
    expect((await flow.h.call({ url: `/v1/intakes/${intake.id}` })).json().intake.workKind).toBe(
      "research",
    );
    const plain = await flow.h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: { projectId: flow.projectId, title: "A change", body: "" },
    });
    expect(plain.json().intake.workKind).toBe("change");
    const bad = await flow.h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: { projectId: flow.projectId, title: "x", body: "", skillIds: ["skl_missing"] },
    });
    expect(bad.statusCode).toBe(422);
  });

  it("refuses web research while local-only mode is on (the default)", async () => {
    const flow = (f = await startFlow());
    const research = (web: boolean) => ({
      workKind: "research",
      research: { sources: { code: true, web } },
    });
    const create = (web: boolean) =>
      flow.h.call({
        method: "POST",
        url: "/v1/intakes",
        payload: { projectId: flow.projectId, title: "Q", body: "", ...research(web) },
      });
    const refused = await create(true);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      code: "local_only",
      message: expect.stringContaining("web research is unavailable"),
    });
    expect((await create(false)).statusCode).toBe(201);
    // An import (or re-import) asking for the web gets the same answer, not the generic 503.
    const imported = await flow.h.call({
      method: "POST",
      url: "/v1/intakes/import",
      payload: {
        projectId: flow.projectId,
        url: "https://github.com/o/r/issues/1",
        ...research(true),
      },
    });
    expect(imported.statusCode).toBe(422);
    expect(imported.json().error.code).toBe("local_only");
    await setLocalOnly(flow, false);
    expect((await create(true)).statusCode).toBe(201);
  });
});

/** A research intake (web on, so local-only is turned off) through spec and an approved plan. */
async function approvedResearchPlan(flow: MimirFlow, notes = "") {
  await setLocalOnly(flow, false);
  const intake = (
    await flow.h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: {
        projectId: flow.projectId,
        title: "How does the reports export work?",
        body: "Explain the CSV export path.",
        workKind: "research",
        ...(notes ? { notes } : {}),
        research: { sources: { web: true, feedbackGraph: false }, factCheck: false },
      },
    })
  ).json().intake;
  const d = await flow.h.call({
    method: "POST",
    url: "/v1/director/draft",
    payload: { projectId: flow.projectId, intakeId: intake.id, request: "How does export work?" },
  });
  expect(d.statusCode).toBe(201);
  const a = await flow.h.call({
    method: "POST",
    url: `/v1/specs/${d.json().spec.id}/answer`,
    payload: { questionId: "Q1", answer: "Date and total" },
  });
  const specId = a.json().spec.id as string;
  await flow.h.call({ method: "POST", url: `/v1/specs/${specId}/submit`, payload: {} });
  await flow.h.call({
    method: "POST",
    url: `/v1/specs/${specId}/approve`,
    payload: {},
    headers: await flow.h.approvalHeaders(),
  });
  const p = await flow.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
  expect(p.statusCode).toBe(201);
  const plan = p.json().plan;
  expect(plan.work).toMatchObject({ kind: "research" });
  expect(plan.tasks.map((t: { id: string; role: string }) => [t.id, t.role])).toEqual([
    ["research", "investigator"],
  ]);
  await flow.h.call({ method: "POST", url: `/v1/plans/${plan.id}/submit`, payload: {} });
  const ok = await flow.h.call({
    method: "POST",
    url: `/v1/plans/${plan.id}/approve`,
    payload: {},
    headers: await flow.h.approvalHeaders(),
  });
  expect(ok.statusCode).toBe(200);
  return { plan: plan as { id: string }, intake };
}

/** A research intake through spec, plan and a finished execution. */
async function researchExecution(flow: MimirFlow, notes = "") {
  const { plan, intake } = await approvedResearchPlan(flow, notes);
  const ex = await flow.h.call({
    method: "POST",
    url: "/v1/executions",
    payload: { planId: plan.id },
  });
  expect(ex.statusCode).toBe(201);
  const execution = ex.json().execution as { id: string };
  await until(
    async () => (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json(),
    (v: { execution: { status: string }; gates: unknown[] }) =>
      v.execution.status === "verified_pending_review" && v.gates.length === 1,
  );
  return { execution, intake };
}

const TRUST_FAKE = { trustedSources: ["fake-mimir"] };

const researchScript = (doc = DOC) => ({
  research: [
    {
      kind: "complete" as const,
      artifacts: ["report@research.md", "file@sources.json"],
      contents: { "report@research.md": doc, "file@sources.json": SOURCES },
    },
  ],
});

describe("research delivery routes", () => {
  it("sends the task mode, gates the document and ends with an approved decision", async () => {
    // The fake Mimir stamps its events `fake-mimir`; production trusts only `mimir.server`.
    const flow = (f = await startMimirFlow(researchScript(), TRUST_FAKE));
    const { execution, intake } = await researchExecution(flow, "Start from the reports page");
    const created = flow.fake.requests.find((r) => r.method === "POST" && r.path === "/v1/tasks");
    expect((created!.body as { mode?: unknown }).mode).toEqual({
      deliverable: "document",
      access: "read",
      network: "web",
    });

    const pr = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/pr`,
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    expect(pr.statusCode).toBe(409);
    expect(pr.json().error.code).toBe("not_exportable");

    const delivered = (await flow.h.call({ url: `/v1/deliveries/${execution.id}` })).json().report;
    expect(delivered.workKind).toBe("research");
    expect(delivered.research).toMatchObject({
      document: { markdown: expect.stringContaining("## Answer") },
      sources: [{ id: "1", kind: "url" }],
      containsPrivateSources: false,
      gate: { passed: true },
      decision: null,
    });

    const noSecret = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/accept`,
      payload: {},
    });
    expect(noSecret.statusCode).toBe(403);
    const noSecretReject = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/reject`,
      payload: { reason: "x" },
    });
    expect(noSecretReject.statusCode).toBe(403);

    const accept = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/accept`,
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().report.research.decision).toMatchObject({ decision: "accepted" });
    const listed = (await flow.h.call({ url: `/v1/deliveries?projectId=${flow.projectId}` })).json()
      .deliveries;
    expect(listed.find((d: { id: string }) => d.id === execution.id)).toMatchObject({
      workKind: "research",
      work: {
        title: "How does the reports export work?",
        decision: "accepted",
        posted: false,
        verdict: null,
        gatePassed: true,
      },
    });
    const reject = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/reject`,
      payload: { reason: "changed my mind" },
      headers: await flow.h.approvalHeaders(),
    });
    expect(reject.statusCode).toBe(409);

    const follow = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/follow-up`,
      payload: { question: "Which columns are exported?" },
    });
    expect(follow.statusCode).toBe(201);
    expect(follow.json().intake).toMatchObject({
      title: "Which columns are exported?",
      workKind: "research",
      linkedExecutionId: execution.id,
      notes: "Start from the reports page",
      research: { sources: { web: true, feedbackGraph: false }, factCheck: false },
    });
    // The question alone is the request; the earlier document is linked, not pasted in.
    expect(follow.json().intake.body).toBe("Which columns are exported?");
    expect(intake.id).not.toBe(follow.json().intake.id);

    // A question at the cap is kept whole; the earlier document reaches the plan as context.
    const long = `Which columns? ${"x".repeat(7980)}`;
    const followLong = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/follow-up`,
      payload: { question: long },
    });
    expect(followLong.statusCode).toBe(201);
    const d = await flow.h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: {
        projectId: flow.projectId,
        intakeId: followLong.json().intake.id,
        request: "Which columns?",
      },
    });
    const a = await flow.h.call({
      method: "POST",
      url: `/v1/specs/${d.json().spec.id}/answer`,
      payload: { questionId: "Q1", answer: "Date and total" },
    });
    const specId = a.json().spec.id as string;
    await flow.h.call({ method: "POST", url: `/v1/specs/${specId}/submit`, payload: {} });
    await flow.h.call({
      method: "POST",
      url: `/v1/specs/${specId}/approve`,
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    const p = await flow.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    expect(p.statusCode).toBe(201);
    const research = p.json().plan.work.research;
    expect(research.question).toBe(long);
    expect(research.context).toMatchObject({
      executionId: execution.id,
      document: expect.stringContaining("Exports stream rows"),
    });
    const tooLong = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/follow-up`,
      payload: { question: "y".repeat(8001) },
    });
    expect(tooLong.statusCode).toBe(422);

    // With local-only mode back on, a follow-up would ask for the web again: refused.
    await setLocalOnly(flow, true);
    const local = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/follow-up`,
      payload: { question: "And the PDF export?" },
    });
    expect(local.statusCode).toBe(422);
    expect(local.json().error.code).toBe("local_only");
  });

  it("refuses to start a web research plan while local-only mode is on", async () => {
    const flow = (f = await startMimirFlow(researchScript(), TRUST_FAKE));
    const { plan } = await approvedResearchPlan(flow);
    await setLocalOnly(flow, true);
    const ex = await flow.h.call({
      method: "POST",
      url: "/v1/executions",
      payload: { planId: plan.id },
    });
    expect(ex.statusCode).toBe(503);
    expect(ex.json().error).toMatchObject({
      code: "local_only",
      message: expect.stringContaining("needs the web"),
    });
    expect(flow.fake.requests.some((r) => r.path === "/v1/tasks")).toBe(false);
  });

  it("refuses to accept a document whose gates failed, but takes a rejection", async () => {
    const flow = (f = await startMimirFlow(
      researchScript("## Answer\nNo sources [4]."),
      TRUST_FAKE,
    ));
    const { execution } = await researchExecution(flow);
    const accept = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/accept`,
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    expect(accept.statusCode).toBe(409);
    const reject = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/reject`,
      payload: { reason: "Sections are missing" },
      headers: await flow.h.approvalHeaders(),
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().report.research.decision).toMatchObject({
      decision: "rejected",
      reason: "Sections are missing",
    });
  });

  it("refuses document decisions on a code change", async () => {
    const flow = (f = await startMimirFlow());
    const res = await flow.h.call({
      method: "POST",
      url: "/v1/executions/exe_missing/accept",
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});
