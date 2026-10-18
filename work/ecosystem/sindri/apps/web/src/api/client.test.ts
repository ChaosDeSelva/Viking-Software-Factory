import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./client.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("api client", () => {
  it("sends the bearer token on reads", async () => {
    const fetch = vi.fn(async () => json(200, { projects: [] }));
    const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
    await expect(api.listProjects()).resolves.toEqual([]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/projects");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(init.headers).get("idempotency-key")).toBeNull();
  });

  it("sends JSON and a fresh Idempotency-Key on mutations", async () => {
    const fetch = vi.fn(async () =>
      json(201, { project: { id: "p1", name: "A", repoPath: "/a" } }),
    );
    let n = 0;
    const api = createApiClient({
      baseUrl: "http://x",
      getToken: () => "tok",
      fetch,
      newKey: () => `key-${++n}`,
    });
    await api.createProject({ name: "A", repoPath: "/a" });
    await api.createProject({ name: "A", repoPath: "/a" });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("http://x/v1/projects");
    expect(calls[0]![1].method).toBe("POST");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ name: "A", repoPath: "/a" });
    const h0 = new Headers(calls[0]![1].headers);
    expect(h0.get("idempotency-key")).toBe("key-1");
    expect(h0.get("content-type")).toBe("application/json");
    expect(new Headers(calls[1]![1].headers).get("idempotency-key")).toBe("key-2");
  });

  it("sends eraseEvidence on project data delete only when asked", async () => {
    const fetch = vi.fn(async () => json(200, { deleted: { projectId: "p1" } }));
    const api = createApiClient({ baseUrl: "", getToken: () => "t", fetch });
    await api.deleteProjectData("p1", "Demo");
    await api.deleteProjectData("p1", "Demo", { eraseEvidence: true });
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![1].method).toBe("DELETE");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ confirm: "Demo" });
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ confirm: "Demo", eraseEvidence: true });
  });

  it("encodes query parameters", async () => {
    const fetch = vi.fn(async () => json(200, { hits: [] }));
    const api = createApiClient({ baseUrl: "", getToken: () => "t", fetch });
    await api.search("p/1", "a b&c");
    expect((fetch.mock.calls as unknown as [string][])[0]![0]).toBe(
      "/v1/projects/p%2F1/search?q=a+b%26c",
    );
  });

  it("throws ApiError with the envelope code and message", async () => {
    const fetch = vi.fn(async () =>
      json(409, { error: { code: "invalid_state", message: "blocking Q1" } }),
    );
    const api = createApiClient({ baseUrl: "", getToken: () => "t", fetch });
    const err = await api.approveSpec("s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "invalid_state", message: "blocking Q1" });
  });

  it("reports network failures as ApiError network_error", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const api = createApiClient({ baseUrl: "", getToken: () => "t", fetch });
    await expect(api.listProjects()).rejects.toMatchObject({ code: "network_error", status: 0 });
  });
});
