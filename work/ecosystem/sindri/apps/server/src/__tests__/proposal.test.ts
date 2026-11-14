import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFlow, type Flow } from "./flow.js";

let f: Flow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** Another registered project the plan may read. */
async function otherProject(flow: Flow, name: string) {
  const repo = mkdtempSync(join(tmpdir(), `sindri-${name}-`));
  const res = await flow.h.call({
    method: "POST",
    url: "/v1/projects",
    payload: { name, repoPath: repo },
  });
  expect(res.statusCode).toBe(201);
  return res.json().project.id as string;
}

describe("plan (proposal) intakes", () => {
  it("takes pasted text up to 200,000 characters and the projects it reads", async () => {
    const flow = (f = await startFlow());
    const docs = await otherProject(flow, "docs");
    // A call transcript is long: well past the 64K limit of other kinds' request text.
    const transcript = `Call transcript. ${"word ".repeat(20_000)}END-OF-CALL`;
    const res = await flow.h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: {
        projectId: flow.projectId,
        title: "Plan from the kickoff call",
        body: transcript,
        workKind: "proposal",
        notes: "Four weeks, demo every Friday",
        proposal: { referenceProjectIds: [docs] },
      },
    });
    expect(res.statusCode).toBe(201);
    const intake = res.json().intake;
    expect(intake).toMatchObject({
      workKind: "proposal",
      proposal: {
        referenceProjectIds: [docs],
        sources: { code: true, web: false },
        factCheck: true,
      },
    });
    // The view shows a shortened display copy; the stored text (what agents get) is whole.
    const stored = flow.h.db
      .prepare("SELECT raw_snapshot_json FROM intakes WHERE id = ?")
      .get(intake.id) as { raw_snapshot_json: string };
    expect(JSON.parse(stored.raw_snapshot_json).body).toBe(transcript);
    expect((await flow.h.call({ url: `/v1/intakes/${intake.id}` })).json().intake.proposal).toEqual(
      intake.proposal,
    );
  });

  it("refuses text over the plan limit, other kinds over theirs, and unknown projects", async () => {
    const flow = (f = await startFlow());
    const post = (payload: Record<string, unknown>) =>
      flow.h.call({ method: "POST", url: "/v1/intakes", payload });
    const base = { projectId: flow.projectId, title: "t" };
    expect(
      (await post({ ...base, body: "x".repeat(200_001), workKind: "proposal" })).statusCode,
    ).toBe(422);
    // Other kinds keep their own limit.
    expect((await post({ ...base, body: "x".repeat(70_000) })).statusCode).toBe(422);
    const unknown = await post({
      ...base,
      body: "text",
      workKind: "proposal",
      proposal: { referenceProjectIds: ["prj_missing"] },
    });
    expect([404, 422]).toContain(unknown.statusCode);
    expect((await post({ ...base, body: "text", proposal: { factCheck: false } })).statusCode).toBe(
      422,
    );
  });

  it("suggests the registered projects a pasted text mentions", async () => {
    const flow = (f = await startFlow());
    const docs = await otherProject(flow, "docs-site");
    const res = await flow.h.call({
      method: "POST",
      url: "/v1/intakes/detect-projects",
      payload: { text: "We should update the Docs Site and the docs_site build." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([
      expect.objectContaining({ projectId: docs, name: "docs-site", mentions: 2, weak: false }),
    ]);
    const empty = await flow.h.call({
      method: "POST",
      url: "/v1/intakes/detect-projects",
      payload: { text: "" },
    });
    expect(empty.statusCode).toBe(422);
  });

  it("plans one research task per project, each reading its project, then the writer", async () => {
    const flow = (f = await startFlow());
    const docs = await otherProject(flow, "docs-site");
    const intake = (
      await flow.h.call({
        method: "POST",
        url: "/v1/intakes",
        payload: {
          projectId: flow.projectId,
          title: "Plan from the call",
          body: "We talked about the reports page and the docs-site.",
          workKind: "proposal",
          proposal: { referenceProjectIds: [docs] },
        },
      })
    ).json().intake;
    const d = await flow.h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId: flow.projectId, intakeId: intake.id, request: "Plan from the call" },
    });
    expect(d.statusCode).toBe(201);
    const a = await flow.h.call({
      method: "POST",
      url: `/v1/specs/${d.json().spec.id}/answer`,
      payload: { questionId: "Q1", answer: "Yes" },
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
    expect(JSON.stringify(p.json().error ?? null)).toBe("null");
    expect(p.statusCode).toBe(201);
    const plan = p.json().plan;
    expect(plan.work.kind).toBe("proposal");
    const [ref] = plan.work.proposal.references;
    expect(ref).toMatchObject({ projectId: docs, name: "docs-site", slug: "docs-site" });
    // The other project is readable at a path of its own (a snapshot, else its checkout).
    expect(typeof ref.path).toBe("string");
    // The research task's working directory is the request's own project, not this one.
    expect(ref.label).not.toMatch(/working directory/i);
    expect(ref.path.length).toBeGreaterThan(0);
    expect(plan.tasks.map((t: { id: string }) => t.id)).toEqual([
      "research",
      "research-docs-site",
      "proposal",
      "fact-check",
    ]);
  });
});
