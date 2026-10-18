import { openDatabase, openKnowledge } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import type { Connector } from "./connectors.js";
import { MAX_RAW_PAYLOAD_BYTES, openIntake } from "./intake.js";

const big = { blob: "x".repeat(400 * 1024) };
const connector: Connector = {
  kind: "jira",
  canHandle: () => true,
  parseUrl: (url) => ({ source: "jira", key: "PROJ-1", url }),
  fetchIssue: () =>
    Promise.resolve({
      source: "jira",
      externalId: "PROJ-1",
      url: "https://acme.atlassian.net/browse/PROJ-1",
      title: "t",
      body: "b",
      updated: "v1",
      raw: big,
    }),
  fetchComments: () => Promise.resolve({ comments: [], raw: big }),
};

describe("raw connector payloads are bounded (review m6)", () => {
  it("stores a marker instead of a raw payload over 256 KB", async () => {
    expect(MAX_RAW_PAYLOAD_BYTES).toBe(256 * 1024);
    const db = openDatabase(":memory:");
    const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/r" }).id;
    const intake = openIntake(db, { connectors: [connector] });
    const rec = await intake.importFromUrl("https://acme.atlassian.net/browse/PROJ-1", {
      projectId,
    });
    expect(rec.snapshot.raw).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect(rec.snapshot.rawComments).toEqual({ truncated: true, bytes: expect.any(Number) });
    const row = db.prepare("SELECT length(raw_snapshot_json) AS n FROM intakes").get() as {
      n: number;
    };
    expect(row.n).toBeLessThan(10_000);
  });
});
