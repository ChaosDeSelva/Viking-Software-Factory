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

  it("accepts a URL object, defaults the route method to GET and sends string bodies as they are", async () => {
    const replay = createReplayFetch([
      { url: "https://x.test/text", body: "plain text", headers: { "content-type": "text/plain" } },
      { url: "https://x.test/json", status: 404, body: { error: "gone" }, headers: { "x-a": "1" } },
    ]);
    const text = await replay.fetch(new URL("https://x.test/text"));
    expect(await text.text()).toBe("plain text");
    expect(text.headers.get("content-type")).toBe("text/plain");
    const json = await replay.fetch("https://x.test/json", { method: "get" });
    expect(json.status).toBe(404);
    expect(json.headers.get("content-type")).toBe("application/json");
    expect(json.headers.get("x-a")).toBe("1");
    expect(await json.json()).toEqual({ error: "gone" });
    // A GET route does not answer another method on the same URL.
    await expect(replay.fetch("https://x.test/text", { method: "DELETE" })).rejects.toThrow(
      "unexpected request: DELETE https://x.test/text",
    );
    // A non-string body (here bytes) is not recorded.
    expect(replay.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://x.test/text",
      "GET https://x.test/json",
      "DELETE https://x.test/text",
    ]);
    expect(replay.requests.every((r) => r.body === undefined)).toBe(true);
  });

  it("takes method, headers and body from a Request object", async () => {
    const replay = createReplayFetch([
      { method: "POST", url: "https://x.test/items", status: 201, body: { id: 1 } },
      { url: "https://x.test/items", body: [] },
    ]);
    const created = await replay.fetch(
      new Request("https://x.test/items", {
        method: "POST",
        headers: { "X-Token": "t" },
        body: '{"name":"a"}',
      }),
    );
    expect(created.status).toBe(201);
    const listed = await replay.fetch(new Request("https://x.test/items"));
    expect(await listed.json()).toEqual([]);
    // `init` wins over the Request, as with the real fetch.
    await expect(
      replay.fetch(new Request("https://x.test/items"), { method: "PUT", body: "x" }),
    ).rejects.toThrow("unexpected request: PUT https://x.test/items");
    expect(replay.requests).toEqual([
      {
        method: "POST",
        url: "https://x.test/items",
        headers: { "x-token": "t", "content-type": "text/plain;charset=UTF-8" },
        body: '{"name":"a"}',
      },
      { method: "GET", url: "https://x.test/items", headers: {} },
      { method: "PUT", url: "https://x.test/items", headers: {}, body: "x" },
    ]);
  });

  it("does not record a body that is not a string", async () => {
    const replay = createReplayFetch([{ method: "POST", url: /upload$/, body: { ok: true } }]);
    await replay.fetch("https://x.test/upload", { method: "POST", body: new Uint8Array([1, 2]) });
    expect(replay.requests).toEqual([
      { method: "POST", url: "https://x.test/upload", headers: {} },
    ]);
  });
});
