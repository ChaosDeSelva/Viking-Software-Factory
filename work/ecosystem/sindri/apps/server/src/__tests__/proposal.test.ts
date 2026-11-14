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
});
