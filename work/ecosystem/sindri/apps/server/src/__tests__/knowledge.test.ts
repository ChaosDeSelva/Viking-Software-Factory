import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";

let h: Harness;
let repo: TempRepo;
let projectId: string;
let documentId: string;

beforeEach(async () => {
  repo = createTempRepo({ "README.md": "# Demo\n\nWe use papaparse for CSV.\n" }, { git: true });
  h = await makeHarness();
  projectId = (
    await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "K", repoPath: repo.path },
    })
  ).json().project.id;
  await h.call({ method: "POST", url: `/v1/projects/${projectId}/bootstrap`, payload: {} });
  documentId = (
    await h.call({ method: "GET", url: `/v1/projects/${projectId}/search?q=papaparse` })
  ).json().hits[0].documentId;
});
afterEach(async () => {
  await h.close();
  repo.cleanup();
});

const add = (claim: string, extra: Record<string, unknown> = {}) =>
  h.call({
    method: "POST",
    url: "/v1/knowledge",
    payload: {
      projectId,
      claim,
      sourceRefs: [{ documentId, startLine: 1, endLine: 3 }],
      confidence: 0.9,
      ...extra,
    },
  });

describe("knowledge", () => {
  it("adds an entry with sources and lists valid entries with source labels", async () => {
    const res = await add("CSV uses papaparse");
    expect(res.statusCode).toBe(201);
    expect(res.json().entry).toMatchObject({
      claim: "CSV uses papaparse",
      validity: "valid",
      createdBy: "user",
    });
    const list = await h.call({ method: "GET", url: `/v1/knowledge?projectId=${projectId}` });
    expect(list.statusCode).toBe(200);
    const [e] = list.json().entries;
    expect(e.claim).toBe("CSV uses papaparse");
    expect(e.sources[0]).toMatchObject({ label: "README.md#L1-L3" });
  });

  it("filters by q and requires projectId", async () => {
    await add("CSV uses papaparse");
    await add("Deploys happen on Fridays");
    const list = await h.call({
      method: "GET",
      url: `/v1/knowledge?projectId=${projectId}&q=friday`,
    });
    expect(list.json().entries.map((e: { claim: string }) => e.claim)).toEqual([
      "Deploys happen on Fridays",
    ]);
    expect((await h.call({ method: "GET", url: "/v1/knowledge" })).statusCode).toBe(422);
  });

  it("requires at least one source and a known document", async () => {
    expect((await add("x", { sourceRefs: [] })).statusCode).toBe(422);
    expect((await add("x", { sourceRefs: [{ documentId: "nope" }] })).statusCode).toBe(422);
    expect((await add("x", { sourceRefs: [{ url: "https://example.com/doc" }] })).statusCode).toBe(
      201,
    );
    expect((await add("x", { projectId: "nope" })).statusCode).toBe(404);
  });

  it("supersedes, retracts and reports history", async () => {
    const first = (await add("Uses papaparse 4")).json().entry;
    const sup = await h.call({
      method: "POST",
      url: `/v1/knowledge/${first.id}/supersede`,
      payload: {
        claim: "Uses papaparse 5",
        sourceRefs: [{ documentId, startLine: 1, endLine: 2 }],
        confidence: 0.8,
      },
    });
    expect(sup.statusCode).toBe(201);
    const second = sup.json().entry;
    expect(second.supersedesId).toBe(first.id);
    const again = await h.call({
      method: "POST",
      url: `/v1/knowledge/${first.id}/supersede`,
      payload: {
        claim: "y",
        sourceRefs: [{ documentId, startLine: 1, endLine: 2 }],
        confidence: 0.8,
      },
    });
    expect(again.statusCode).toBe(409);
    const hist = await h.call({ method: "GET", url: `/v1/knowledge/${second.id}/history` });
    expect(hist.json().history.map((e: { id: string }) => e.id)).toEqual([first.id, second.id]);

    const ret = await h.call({
      method: "POST",
      url: `/v1/knowledge/${second.id}/retract`,
      payload: { reason: "wrong" },
    });
    expect(ret.statusCode).toBe(200);
    expect(ret.json().entry.validity).toBe("retracted");
    const twice = await h.call({
      method: "POST",
      url: `/v1/knowledge/${second.id}/retract`,
      payload: { reason: "wrong" },
    });
    expect(twice.statusCode).toBe(409);
    expect(
      (
        await h.call({
          method: "POST",
          url: "/v1/knowledge/nope/retract",
          payload: { reason: "r" },
        })
      ).statusCode,
    ).toBe(404);
    expect((await h.call({ method: "GET", url: "/v1/knowledge/nope/history" })).statusCode).toBe(
      404,
    );
    const list = await h.call({ method: "GET", url: `/v1/knowledge?projectId=${projectId}` });
    expect(list.json().entries).toEqual([]);
  });
});
