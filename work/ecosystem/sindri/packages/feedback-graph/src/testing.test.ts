import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fgLesson, startStubFeedbackGraph, type StubFeedbackGraph } from "./testing.js";

let fg: StubFeedbackGraph;
beforeEach(async () => {
  fg = await startStubFeedbackGraph();
});
afterEach(async () => {
  await fg.close();
});

const get = (path: string, token: string | null = fg.token) =>
  fetch(`${fg.url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

describe("stub Feedback Graph", () => {
  it("answers health without a token and refuses other routes without one", async () => {
    expect(await (await get("/api/health", null)).json()).toEqual({ ok: true });
    expect((await get("/api/lessons?project=p", null)).status).toBe(401);
  });

  it("answers unknown routes 404 and missing parameters as untracked / empty", async () => {
    expect((await get("/api/nope")).status).toBe(404);
    expect(await (await get("/api/agent/project")).json()).toEqual({
      project: null,
      tracked: false,
    });
    expect(await (await get("/api/lessons")).json()).toEqual([]);
  });

  it("filters lessons by status, keeping lessons without one", async () => {
    fg.lessons.set("p", [
      fgLesson("a"),
      fgLesson("b", { status: "proposed" }),
      { id: "c", rule: "r" },
      null,
    ]);
    const ids = async (q: string) =>
      ((await (await get(`/api/lessons?${q}`)).json()) as ({ id: string } | null)[]).map(
        (l) => l?.id ?? null,
      );
    expect(await ids("project=p&status=approved")).toEqual(["a", "c", null]);
    expect(await ids("project=p")).toEqual(["a", "b", "c", null]);
  });
});
