import { describe, expect, it } from "vitest";
import { createReplayFetch } from "./replay-fetch.js";

describe("createReplayFetch", () => {
  it("replays JSON for matching method + URL and records requests", async () => {
    const replay = createReplayFetch([
      { method: "GET", url: "https://x.test/a", body: { ok: 1 } },
      { method: "POST", url: /graphql$/, status: 201, body: { data: 2 } },
    ]);
    const a = await replay.fetch("https://x.test/a", { headers: { Authorization: "Basic abc" } });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: 1 });
    const b = await replay.fetch("https://y.test/graphql", { method: "POST", body: "{}" });
    expect(b.status).toBe(201);
    expect(replay.requests).toEqual([
      { method: "GET", url: "https://x.test/a", headers: { authorization: "Basic abc" } },
      { method: "POST", url: "https://y.test/graphql", headers: {}, body: "{}" },
    ]);
  });

  it("rejects unmatched requests so tests never reach the network", async () => {
    const replay = createReplayFetch([]);
    await expect(replay.fetch("https://example.com/")).rejects.toThrow(/unexpected request/i);
  });

  it("supports custom predicates", async () => {
    const replay = createReplayFetch([
      {
        method: "POST",
        url: /gql/,
        match: (r) => r.body?.includes("Issue") ?? false,
        body: { hit: true },
      },
    ]);
    await expect(
      replay.fetch("https://a/gql", { method: "POST", body: "query Other" }),
    ).rejects.toThrow();
    const res = await replay.fetch("https://a/gql", { method: "POST", body: "query Issue" });
    expect(await res.json()).toEqual({ hit: true });
  });
});
