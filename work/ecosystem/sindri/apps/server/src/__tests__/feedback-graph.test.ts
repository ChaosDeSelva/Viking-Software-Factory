import { realpathSync } from "node:fs";
import {
  startStubFeedbackGraph,
  fgLesson,
  type StubFeedbackGraph,
} from "@sindri/feedback-graph/testing";
import { openKnowledge } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../settings.js";
import { approvedSpec, startFlow, type Flow } from "./flow.js";

const GOOD = "fg.token";
const BAD = "fg.wrong-token";

let stub: StubFeedbackGraph;
let f: Flow;

beforeEach(async () => {
  stub = await startStubFeedbackGraph();
  f = await startFlow({
    secrets: {
      get: (k) =>
        Promise.resolve(k === GOOD ? stub.token : k === BAD ? "not-the-token" : undefined),
    },
  });
  // Sindri stores the resolved path (on macOS a temp dir is /private/var/..., not /var/...).
  stub.projects.set(realpathSync(f.repo.path), "demo-app");
  stub.lessons.set("demo-app", [
    fgLesson("l1", { projectKey: "demo-app", rule: "Run the export tests before review." }),
    fgLesson("l2", { projectKey: "demo-app", status: "proposed" }),
  ]);
  stub.lessons.set("other-app", [fgLesson("o1", { projectKey: "other-app" })]);
});
afterEach(async () => {
  await f.close();
  await stub.close();
});

const configure = (fg: { url?: string; tokenSecret?: string; enabled?: boolean } | null) =>
  new SettingsStore(f.h.db, () => new Date()).put({
    ...DEFAULT_SETTINGS,
    ...(fg ? { feedbackGraph: { url: stub.url, tokenSecret: GOOD, enabled: true, ...fg } } : {}),
  });

const status = async () => {
  const res = await f.h.call({ method: "GET", url: "/v1/feedback-graph/status" });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const getLink = (id = f.projectId) =>
  f.h.call({ method: "GET", url: `/v1/projects/${id}/feedback-graph` });
const putLink = (payload: unknown, key?: string, id = f.projectId) =>
  f.h.call({
    method: "PUT",
    url: `/v1/projects/${id}/feedback-graph`,
    payload: payload as Record<string, unknown>,
    ...(key === undefined ? {} : { key }),
  });

describe("GET /v1/feedback-graph/status", () => {
  it("is neutral when not configured and when disabled, and never calls Feedback Graph", async () => {
    expect(await status()).toEqual({
      configured: false,
      enabled: false,
      url: null,
      reachable: null,
      error: null,
    });
    configure({ enabled: false });
    expect(await status()).toEqual({
      configured: true,
      enabled: false,
      url: stub.url,
      reachable: null,
      error: null,
    });
    expect(stub.requests).toEqual([]);
  });

  it("reports reachable, a rejected token, and an unreachable server", async () => {
    configure({});
    expect(await status()).toMatchObject({
      configured: true,
      enabled: true,
      reachable: true,
      error: null,
    });
    expect(stub.requests[0]!.authorization).toBe(`Bearer ${stub.token}`);

    configure({ tokenSecret: BAD });
    const denied = await status();
    expect(denied.reachable).toBe(true);
    expect(denied.error).toMatch(/token|401|unauthori/i);

    const gone = await startStubFeedbackGraph();
    const url = gone.url;
    await gone.close();
    configure({ url });
    const down = await status();
    expect(down).toMatchObject({ configured: true, enabled: true, url, reachable: false });
    expect(down.error).toBeTruthy();
  });

  it("needs the bearer token", async () => {
    const res = await f.h.app.inject({
      method: "GET",
      url: "/v1/feedback-graph/status",
      headers: { host: "127.0.0.1" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("/v1/projects/:id/feedback-graph", () => {
  it("links automatically by repo path and lists approved lessons only", async () => {
    configure({});
    const res = await getLink();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      link: { projectKey: "demo-app", source: "auto" },
      lessons: [
        {
          id: "l1",
          title: "Lesson l1",
          rule: "Run the export tests before review.",
          appliesWhen: "when touching l1",
          paths: ["src/l1.ts"],
          status: "approved",
          injectionDetected: false,
        },
      ],
      error: null,
    });
  });

  it("explains why there are no lessons when not configured", async () => {
    const res = await getLink();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      link: { projectKey: null, source: "none" },
      lessons: [],
      error: expect.stringMatching(/not configured/) as unknown,
    });
  });

  it("sets and clears an override, keeping the project's other settings", async () => {
    configure({});
    openKnowledge(f.h.db).projects.setSettings(f.projectId, { executionProfile: { keep: true } });
    const set = await putLink({ projectKey: "  other-app " });
    expect(set.statusCode).toBe(200);
    expect(set.json().link).toEqual({ projectKey: "other-app", source: "override" });
    expect(set.json().lessons.map((l: { id: string }) => l.id)).toEqual(["o1"]);
    const stored = () => openKnowledge(f.h.db).projects.get(f.projectId)!.settings;
    expect(stored()).toEqual({
      executionProfile: { keep: true },
      feedbackGraphProject: "other-app",
    });
    expect((await getLink()).json().link.source).toBe("override");

    const cleared = await putLink({ projectKey: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().link).toEqual({ projectKey: "demo-app", source: "auto" });
    expect(stored()).toEqual({ executionProfile: { keep: true } });
  });

  it("drops the cached automatic link when the override changes", async () => {
    configure({});
    expect((await getLink()).json().link.projectKey).toBe("demo-app");
    // Feedback Graph now maps the path elsewhere: cached until the link is written.
    stub.projects.set(realpathSync(f.repo.path), "other-app");
    expect((await getLink()).json().link.projectKey).toBe("demo-app");
    expect((await putLink({ projectKey: null })).json().link).toEqual({
      projectKey: "other-app",
      source: "auto",
    });
  });

  it("needs an Idempotency-Key, replays a repeated key, and takes no approval factor", async () => {
    configure({});
    const noKey = await f.h.call({
      method: "PUT",
      url: `/v1/projects/${f.projectId}/feedback-graph`,
      payload: { projectKey: "other-app" },
      key: null,
    });
    expect(noKey.statusCode).toBe(422);
    expect(noKey.json().error.code).toBe("idempotency_key_required");
    const first = await putLink({ projectKey: "other-app" }, "fg-link-1");
    const again = await putLink({ projectKey: "other-app" }, "fg-link-1");
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    const unauth = await f.h.app.inject({
      method: "PUT",
      url: `/v1/projects/${f.projectId}/feedback-graph`,
      headers: { host: "127.0.0.1", "idempotency-key": "fg-link-2" },
      payload: { projectKey: null },
    });
    expect(unauth.statusCode).toBe(401);
  });

  it("answers 404 for an unknown project and 422 for a bad body", async () => {
    expect((await getLink("nope")).statusCode).toBe(404);
    expect((await putLink({ projectKey: "x" }, undefined, "nope")).statusCode).toBe(404);
    for (const bad of [
      {},
      { projectKey: "" },
      { projectKey: "   " },
      { projectKey: 7 },
      { projectKey: "has space" },
      { projectKey: "../etc" },
      { projectKey: ".hidden" },
      { projectKey: "a".repeat(201) },
      { projectKey: "ok", extra: true },
    ]) {
      const res = await putLink(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(JSON.stringify((await putLink({ projectKey: ".hidden" })).json())).toContain(
      "must start with a letter, digit or underscore",
    );
    expect(openKnowledge(f.h.db).projects.get(f.projectId)!.settings).toEqual({});
  });
});

describe("lessons in drafting and planning", () => {
  const purposeCalls = (purpose: string) =>
    f.provider.calls.filter((c) => c.metadata?.purpose === purpose);
  const hasLessonBlock = (purpose: string) =>
    purposeCalls(purpose).some((c) =>
      c.messages.some((m) => /<untrusted_data_[0-9a-f]+ id="fg:l1" kind="lesson"/.test(m.content)),
    );

  it("gives the drafter and the planner the project's lessons", async () => {
    configure({});
    const specId = await approvedSpec(f);
    expect(hasLessonBlock("draft_spec")).toBe(true);
    const p = await f.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    expect(p.statusCode).toBe(201);
    expect(hasLessonBlock("plan")).toBe(true);
  });

  it("drafts and plans while Feedback Graph is down", async () => {
    configure({});
    await stub.close();
    stub = await startStubFeedbackGraph();
    stub.override = () => ({ destroy: true });
    configure({ url: stub.url });
    const specId = await approvedSpec(f);
    const p = await f.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    expect(p.statusCode).toBe(201);
    expect(hasLessonBlock("draft_spec")).toBe(false);
    expect(hasLessonBlock("plan")).toBe(false);
  });
});
