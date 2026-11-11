import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  createFeedbackGraphService,
  FAILURE_TTL_MS,
  type FeedbackGraphServiceOptions,
  type FgProjectRef,
} from "./service.js";
import { fgLesson, startStubFeedbackGraph, type StubFeedbackGraph } from "./testing.js";
import type { FgConfig } from "./types.js";

let fg: StubFeedbackGraph;
let clock: number;
let config: FgConfig | undefined;
let projects: Map<string, FgProjectRef>;
let secrets: Map<string, string>;

beforeEach(async () => {
  fg = await startStubFeedbackGraph();
  clock = 1_000_000;
  config = { url: fg.url, tokenSecret: "feedback-graph.token", enabled: true };
  projects = new Map([["p1", { id: "p1", repoPath: "/repos/one" }]]);
  secrets = new Map([["feedback-graph.token", fg.token]]);
  fg.projects.set("/repos/one", "one");
  fg.lessons.set("one", [fgLesson("a"), fgLesson("b", { decidedAt: "2026-11-01T00:00:00Z" })]);
  fg.lessons.set("other", [fgLesson("o")]);
});
afterEach(async () => {
  await fg.close();
});

const service = (o: Partial<FeedbackGraphServiceOptions> = {}) =>
  createFeedbackGraphService({
    config: () => config,
    secrets: { get: async (k) => secrets.get(k) },
    project: (id) => projects.get(id),
    now: () => clock,
    timeoutMs: 1000,
    ...o,
  });

const lessonCalls = () => fg.requests.filter((r) => r.url.startsWith("/api/lessons")).length;

describe("project mapping", () => {
  it("maps automatically through the repo path", async () => {
    const v = await service().projectView("p1");
    expect(v?.link).toEqual({ projectKey: "one", source: "auto" });
    expect(v?.lessons.map((l) => l.id)).toEqual(["b", "a"]);
    expect(v?.error).toBeNull();
  });

  it("uses a stored override instead of the lookup", async () => {
    projects.set("p1", { id: "p1", repoPath: "/repos/one", override: "other" });
    const v = await service().projectView("p1");
    expect(v?.link).toEqual({ projectKey: "other", source: "override" });
    expect(v?.lessons.map((l) => l.id)).toEqual(["o"]);
    expect(fg.requests.some((r) => r.url.startsWith("/api/agent/project"))).toBe(false);
  });

  it("goes back to auto when the override is cleared", async () => {
    const s = service();
    projects.set("p1", { id: "p1", repoPath: "/repos/one", override: "other" });
    expect((await s.projectView("p1"))?.link.source).toBe("override");
    projects.set("p1", { id: "p1", repoPath: "/repos/one", override: null });
    s.invalidate("p1");
    expect((await s.projectView("p1"))?.link).toEqual({ projectKey: "one", source: "auto" });
  });

  it("ignores a stored override that is not a project key", async () => {
    projects.set("p1", { id: "p1", repoPath: "/repos/one", override: "../bad key" });
    expect((await service().projectView("p1"))?.link.source).toBe("auto");
  });

  it("reports an unmapped project with no lessons and no error", async () => {
    projects.set("p2", { id: "p2", repoPath: "/repos/untracked" });
    const s = service();
    expect(await s.projectView("p2")).toEqual({
      link: { projectKey: null, source: "none" },
      lessons: [],
      error: null,
    });
    expect(await s.lessonsFor("p2")).toEqual([]);
  });

  it("is undefined for an unknown Sindri project; lessonsFor is []", async () => {
    expect(await service().projectView("nope")).toBeUndefined();
    expect(await service().lessonsFor("nope")).toEqual([]);
  });
});

describe("lessonsFor", () => {
  it("returns normalised lessons, limited", async () => {
    const s = service();
    expect((await s.lessonsFor("p1")).map((l) => l.id)).toEqual(["b", "a"]);
    expect(await s.lessonsFor("p1", { limit: 1 })).toHaveLength(1);
    expect(await s.lessonsFor("p1", { limit: 0 })).toEqual([]);
  });

  it("caches per project for about a minute, coalescing concurrent calls", async () => {
    const s = service();
    await Promise.all([s.lessonsFor("p1"), s.lessonsFor("p1"), s.lessonsFor("p1")]);
    expect(lessonCalls()).toBe(1);
    clock += CACHE_TTL_MS - 1;
    await s.lessonsFor("p1");
    expect(lessonCalls()).toBe(1);
    clock += 2;
    await s.lessonsFor("p1");
    expect(lessonCalls()).toBe(2);
  });

  it("caches failures for less time", async () => {
    const s = service();
    fg.override = (req) => (req.url?.startsWith("/api/lessons") ? { raw: "nope" } : undefined);
    expect(await s.lessonsFor("p1")).toEqual([]);
    fg.override = undefined;
    expect(await s.lessonsFor("p1")).toEqual([]);
    clock += FAILURE_TTL_MS + 1;
    expect(await s.lessonsFor("p1")).toHaveLength(2);
  });

  it("starts over when the configuration changes", async () => {
    const s = service();
    await s.lessonsFor("p1");
    config = { ...config!, tokenSecret: "other.token" };
    secrets.set("other.token", fg.token);
    await s.lessonsFor("p1");
    expect(lessonCalls()).toBe(2);
  });

  it.each([
    ["not configured", () => (config = undefined), /not configured/],
    ["disabled", () => (config = { ...config!, enabled: false }), /disabled/],
    ["token missing", () => secrets.clear(), /no Feedback Graph token/],
    ["wrong token", () => secrets.set("feedback-graph.token", "wrong"), /rejected the token/],
    ["malformed JSON", () => (fg.override = () => ({ raw: "{]" })), /invalid JSON/],
    [
      "lessons not a list",
      () =>
        (fg.override = (req) =>
          req.url?.startsWith("/api/lessons") ? { json: { lessons: [] } } : undefined),
      /not a list/,
    ],
    [
      "too large",
      () =>
        (fg.override = (req) =>
          req.url?.startsWith("/api/lessons") ? { raw: `[${'"x",'.repeat(5000)}"x"]` } : undefined),
      /larger than/,
    ],
  ])("%s: lessonsFor is [] and the view says why", async (_name, arrange, message) => {
    arrange();
    const s = service({ maxBytes: 10_000 });
    expect(await s.lessonsFor("p1")).toEqual([]);
    const v = await s.projectView("p1");
    expect(v?.lessons).toEqual([]);
    expect(v?.error).toMatch(message);
  });

  it("unreachable: lessonsFor is []", async () => {
    await fg.close();
    fg = await startStubFeedbackGraph();
    const s = service();
    expect(await s.lessonsFor("p1")).toEqual([]);
    expect((await s.projectView("p1"))?.error).toMatch(/not reachable/);
  });

  it("blocked by local-only: no request is made", async () => {
    const s = service({ blocked: () => "local-only mode allows Feedback Graph only on loopback" });
    expect(await s.lessonsFor("p1")).toEqual([]);
    expect((await s.projectView("p1"))?.error).toMatch(/local-only/);
    expect(fg.requests).toHaveLength(0);
  });

  it("never throws, even when a dependency does", async () => {
    const s = service({
      project: () => {
        throw new Error("db gone");
      },
      secrets: {
        get: () => Promise.reject(new Error("keychain locked")),
      },
    });
    expect(await s.lessonsFor("p1")).toEqual([]);
    const s2 = service({ secrets: { get: () => Promise.reject(new Error("locked")) } });
    expect(await s2.lessonsFor("p1")).toEqual([]);
  });
});

describe("status", () => {
  it("not configured", async () => {
    config = undefined;
    expect(await service().status()).toEqual({
      configured: false,
      enabled: false,
      url: null,
      reachable: null,
      error: null,
    });
  });

  it("disabled: not probed", async () => {
    config = { ...config!, enabled: false };
    expect(await service().status()).toEqual({
      configured: true,
      enabled: false,
      url: fg.url,
      reachable: null,
      error: null,
    });
    expect(fg.requests).toHaveLength(0);
  });

  it("reachable with a working token", async () => {
    expect(await service().status()).toEqual({
      configured: true,
      enabled: true,
      url: fg.url,
      reachable: true,
      error: null,
    });
  });

  it("reachable but the token is rejected", async () => {
    secrets.set("feedback-graph.token", "nope");
    expect(await service().status()).toMatchObject({
      reachable: true,
      error: expect.stringMatching(/rejected the token/),
    });
  });

  it("unreachable", async () => {
    const url = fg.url;
    await fg.close();
    fg = await startStubFeedbackGraph();
    config = { ...config!, url };
    expect(await service().status()).toMatchObject({
      reachable: false,
      error: expect.stringMatching(/not reachable/),
    });
  });

  it("token missing: not probed", async () => {
    secrets.clear();
    expect(await service().status()).toMatchObject({ reachable: null, error: expect.any(String) });
  });

  it("is cached briefly", async () => {
    const s = service();
    await s.status();
    await s.status();
    expect(fg.requests).toHaveLength(1);
    s.invalidate();
    await s.status();
    expect(fg.requests).toHaveLength(2);
  });
});
