import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedbackGraphClient } from "./client.js";
import { fgLesson, startStubFeedbackGraph, type StubFeedbackGraph } from "./testing.js";

let fg: StubFeedbackGraph;
beforeEach(async () => {
  fg = await startStubFeedbackGraph();
});
afterEach(async () => {
  await fg.close();
});

const client = (o: { token?: string; timeoutMs?: number; maxBytes?: number; url?: string } = {}) =>
  new FeedbackGraphClient({ url: o.url ?? fg.url, token: o.token ?? fg.token, ...o });

describe("FeedbackGraphClient", () => {
  it("maps a host directory to a project key with the bearer token", async () => {
    fg.projects.set("/repo/a", "alpha");
    expect(await client().projectFor("/repo/a")).toEqual({ ok: true, value: "alpha" });
    expect(await client().projectFor("/repo/unknown")).toEqual({ ok: true, value: null });
    expect(fg.requests[0]).toMatchObject({
      url: "/api/agent/project?cwd=%2Frepo%2Fa",
      authorization: `Bearer ${fg.token}`,
    });
  });

  it("asks for approved lessons of one project", async () => {
    fg.lessons.set("alpha", [fgLesson("l1")]);
    const r = await client().lessons("alpha");
    expect(r.ok && Array.isArray(r.value) && r.value.length).toBe(1);
    expect(fg.requests[0]!.url).toBe("/api/lessons?project=alpha&status=approved");
  });

  it("reports a wrong token as unauthorized, without the token", async () => {
    const r = await client({ token: "wrong-secret-token" }).lessons("alpha");
    expect(r).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(JSON.stringify(r)).not.toContain("wrong-secret-token");
  });

  it("reports an unreachable server", async () => {
    const url = fg.url;
    await fg.close();
    fg = await startStubFeedbackGraph();
    expect(await client({ url }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
  });

  it("times out a server that never answers", async () => {
    fg.override = () => ({ hang: true });
    expect(await client({ timeoutMs: 200 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("reports a dropped connection as unreachable", async () => {
    fg.override = () => ({ destroy: true });
    expect(await client().lessons("x")).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
  });

  it("rejects malformed JSON and unexpected shapes", async () => {
    fg.override = () => ({ raw: "{not json" });
    expect(await client().lessons("x")).toMatchObject({
      ok: false,
      error: { code: "invalid_response" },
    });
    fg.override = () => ({ json: [1, 2] });
    expect(await client().projectFor("/r")).toMatchObject({
      ok: false,
      error: { code: "invalid_response" },
    });
    fg.override = () => ({ json: { project: 5 } });
    expect(await client().projectFor("/r")).toMatchObject({
      ok: false,
      error: { code: "invalid_response" },
    });
  });

  it("refuses bodies over the size limit, declared or streamed", async () => {
    fg.override = () => ({ raw: "x".repeat(5000) });
    expect(await client({ maxBytes: 1000 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "too_large" },
    });
  });

  it("reports other HTTP failures by status", async () => {
    fg.override = () => ({ status: 500, json: { error: "boom" } });
    expect(await client().lessons("x")).toMatchObject({
      ok: false,
      error: { code: "http_error", message: "Feedback Graph answered 500" },
    });
  });

  it("does not follow redirects (the token stays with the configured origin)", async () => {
    fg.override = (req) =>
      req.url?.startsWith("/api/lessons")
        ? { status: 302, raw: "", headers: { location: `${fg.url}/api/health` } }
        : undefined;
    expect(await client().lessons("x")).toMatchObject({
      ok: false,
      error: { code: "unreachable" },
    });
    expect(fg.requests.map((r) => r.url)).not.toContain("/api/health");
  });

  it("refuses a body whose declared length is over the limit without reading it", async () => {
    fg.override = () => ({ raw: "x".repeat(5000), headers: { "content-length": "5000" } });
    expect(await client({ maxBytes: 1000 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "too_large" },
    });
  });

  it("reports an empty body as invalid JSON", async () => {
    fg.override = () => ({ status: 204, raw: "" });
    expect(await client().lessons("x")).toMatchObject({
      ok: false,
      error: { code: "invalid_response", message: "Feedback Graph answered with invalid JSON" },
    });
  });

  it("times out a body that stops arriving", async () => {
    fg.override = () => ({ partial: '[{"id":', then: "hang" });
    expect(await client({ timeoutMs: 300 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("reports a connection dropped mid-body as unreachable", async () => {
    fg.override = () => ({ partial: '[{"id":', then: "destroy" });
    expect(await client().lessons("x")).toEqual({
      ok: false,
      error: { code: "unreachable", message: "Feedback Graph closed the connection" },
    });
  });

  // An auth failure is known from the status line: a large or never-ending error page from a
  // proxy in front of Feedback Graph must not turn it into "too large" or "timeout".
  it("reports a rejected token even when the error body is oversized or never ends", async () => {
    fg.override = () => ({ status: 401, raw: "x".repeat(5000) });
    expect(await client({ maxBytes: 1000 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    fg.override = () => ({ status: 403, partial: "<html>", then: "hang" });
    expect(await client({ timeoutMs: 300 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    fg.override = () => ({ status: 502, partial: "<html>", then: "hang" });
    expect(await client({ timeoutMs: 300 }).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "http_error", message: "Feedback Graph answered 502" },
    });
  });

  it("still answers when dropping an unread body fails", async () => {
    // A body whose cancel throws, as a misbehaving fetch or proxy stream can.
    const body = (chunk = "x".repeat(2000)) =>
      new ReadableStream<Uint8Array>({
        pull: (c) => c.enqueue(new TextEncoder().encode(chunk)),
        cancel: () => {
          throw new Error("cannot cancel");
        },
      });
    const via = (res: () => Response) =>
      new FeedbackGraphClient({
        url: fg.url,
        token: "t",
        maxBytes: 1000,
        fetch: async () => res(),
      });
    expect(await via(() => new Response(body(), { status: 500 })).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "http_error" },
    });
    expect(
      await via(() => new Response(body(), { headers: { "content-length": "5000" } })).lessons("x"),
    ).toMatchObject({ ok: false, error: { code: "too_large" } });
    expect(await via(() => new Response(body())).lessons("x")).toMatchObject({
      ok: false,
      error: { code: "too_large" },
    });
  });

  it("refuses an invalid base URL without throwing", async () => {
    expect(await client({ url: "not a url" }).lessons("x")).toMatchObject({ ok: false });
  });
});
