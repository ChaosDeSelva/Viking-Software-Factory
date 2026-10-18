import { describe, expect, it, vi } from "vitest";
import { createClient, describeError, isUnauthorized } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createClient (real @mimir/sdk, injected fetch)", () => {
  it("sends the bearer token and parses the response", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ status: "ok" }),
    );
    const client = createClient({ baseUrl: "http://127.0.0.1:7700", token: "secret", fetch });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:7700/v1/health");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("normalizes events.list into an EventsPage", async () => {
    const fetch = vi.fn(async () => jsonResponse({ events: [], nextCursor: null }));
    const client = createClient({ baseUrl: "http://x", token: "t", fetch });
    await expect(client.events.list({ limit: 5 })).resolves.toMatchObject({
      events: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("surfaces server errors as MimirError codes", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: { code: "unauthorized", message: "bad token" } }, 401),
    );
    const client = createClient({ baseUrl: "http://x", token: "t", fetch });
    const err = await client.snapshot().catch((e: unknown) => e);
    expect(isUnauthorized(err)).toBe(true);
    expect(describeError(err)).toEqual({ code: "unauthorized", message: "bad token" });
  });
});

describe("describeError", () => {
  it("formats MimirError-like errors with their code", () => {
    const err = Object.assign(new Error("needs approval"), {
      name: "MimirError",
      code: "policy_denied",
      status: 403,
    });
    expect(describeError(err)).toEqual({ code: "policy_denied", message: "needs approval" });
  });

  it("formats plain errors and unknown values", () => {
    expect(describeError(new Error("boom"))).toEqual({ code: null, message: "boom" });
    expect(describeError("x")).toEqual({ code: null, message: "Unknown error" });
  });
});
