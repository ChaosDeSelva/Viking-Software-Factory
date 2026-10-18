import { FakeProvider } from "@sindri/director";
import { openIntake } from "@sindri/intake";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoResponder } from "../demo-responder.js";
import { makeHarness, type Harness } from "./helpers.js";

const MARKERS = [
  "quokkatitle",
  "quokkabody",
  "quokkareadme",
  "quokkaclaim",
  "quokkaanswer",
  "quokkablob",
];

let h: Harness;
let repo: TempRepo;
let keep: TempRepo;

beforeEach(async () => {
  repo = createTempRepo({ "README.md": "# Gone\n\nquokkareadme lives here\n" }, { git: true });
  keep = createTempRepo({ "README.md": "# Kept\n\nwombatreadme stays\n" }, { git: true });
  h = await makeHarness({ providerFactory: () => new FakeProvider(demoResponder()) });
});
afterEach(async () => {
  await h.close();
  repo.cleanup();
  keep.cleanup();
});

const exportBytes = async () => {
  const res = await h.call({ method: "GET", url: "/v1/export" });
  expect(res.statusCode).toBe(200);
  return Buffer.from(unzipSync(new Uint8Array(res.rawPayload))["sindri.db"]!);
};

describe("DELETE /v1/projects/:id/data purges all project content (I2)", () => {
  it("leaves no trace in tables, the idempotency ledger, attachment blobs or the export", async () => {
    const mk = async (name: string, path: string) =>
      (
        await h.call({ method: "POST", url: "/v1/projects", payload: { name, repoPath: path } })
      ).json().project.id as string;
    const gone = await mk("Gone", repo.path);
    const kept = await mk("Kept", keep.path);
    for (const id of [gone, kept])
      await h.call({ method: "POST", url: `/v1/projects/${id}/bootstrap`, payload: {} });

    const intakeId = (
      await h.call({
        method: "POST",
        url: "/v1/intakes",
        payload: { projectId: gone, title: "quokkatitle", body: "quokkabody" },
      })
    ).json().intake.id;
    const draft = (
      await h.call({
        method: "POST",
        url: "/v1/director/draft",
        payload: { projectId: gone, intakeId, request: "quokkatitle csv" },
      })
    ).json();
    const v2 = (
      await h.call({
        method: "POST",
        url: `/v1/specs/${draft.spec.id}/answer`,
        payload: { questionId: "Q1", answer: "quokkaanswer" },
      })
    ).json().spec.id;
    await h.call({ method: "POST", url: `/v1/specs/${v2}/submit`, payload: {} });
    await h.call({ method: "POST", url: `/v1/specs/${v2}/approve`, payload: { approver: "me" } });
    await h.call({
      method: "POST",
      url: "/v1/knowledge",
      payload: {
        projectId: gone,
        claim: "quokkaclaim",
        sourceRefs: [{ url: "https://x.dev" }],
        confidence: 0.5,
      },
    });
    // Attachment blobs (manual attachments are written by the intake package).
    const attachmentsDir = join(h.dir, "attachments");
    const intake = openIntake(h.db, { attachmentsDir });
    intake.createManual({
      projectId: gone,
      title: "with file",
      body: "",
      attachments: [{ name: "a.txt", content: "quokkablob" }],
    });
    intake.createManual({
      projectId: kept,
      title: "shared",
      body: "",
      attachments: [{ name: "s.txt", content: "shared-blob" }],
    });
    intake.createManual({
      projectId: gone,
      title: "shared",
      body: "",
      attachments: [{ name: "s.txt", content: "shared-blob" }],
    });
    const blobs = intake.attachmentPaths(gone);
    expect(blobs).toHaveLength(2);

    const before = await exportBytes();
    for (const m of MARKERS.filter((x) => x !== "quokkablob"))
      expect(before.includes(m), m).toBe(true);

    const del = await h.call({
      method: "DELETE",
      url: `/v1/projects/${gone}/data`,
      payload: { confirm: "Gone" },
    });
    expect(del.statusCode).toBe(200);

    const after = await exportBytes();
    for (const m of MARKERS) expect(after.includes(m), `export still contains ${m}`).toBe(false);
    expect(after.includes("wombatreadme")).toBe(true);
    const commands = h.db.prepare("SELECT url, response FROM commands").all() as {
      url: string;
      response: string | null;
    }[];
    for (const c of commands) {
      expect(c.url).not.toContain(gone === "" ? "x" : `${gone}/bootstrap`);
      for (const m of MARKERS) expect(c.response ?? "").not.toContain(m);
    }
    // The project's own blob is gone, the shared blob (still used by "Kept") stays.
    expect(blobs.filter((p) => existsSync(p))).toHaveLength(1);
    expect((await h.call({ method: "GET", url: `/v1/projects/${kept}` })).statusCode).toBe(200);
    // The delete itself is still replayable by its Idempotency-Key semantics (a fresh key 404s).
    expect(
      (
        await h.call({
          method: "DELETE",
          url: `/v1/projects/${gone}/data`,
          payload: { confirm: "Gone" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("tags ledger rows with their project", async () => {
    const id = (
      await h.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "T", repoPath: repo.path },
      })
    ).json().project.id;
    await h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: { projectId: id, title: "t", body: "b" },
    });
    const rows = h.db.prepare("SELECT project_id FROM commands WHERE state = 'done'").all() as {
      project_id: string | null;
    }[];
    expect(rows.map((r) => r.project_id)).toEqual([id, id]);
  });
});
