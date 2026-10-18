import { describe, expect, it } from "vitest";
import { parseHash, routeHash } from "./route.js";
import { initialState, reducer } from "./reducer.js";

describe("hash routes (audit S-I1)", () => {
  it("round-trips the view and selections", () => {
    const state = {
      ...initialState({}),
      view: "runs" as const,
      projectId: "p 1",
      executionId: "exe_1",
    };
    const hash = routeHash(state);
    expect(hash).toBe("#/runs?project=p+1&execution=exe_1");
    expect(parseHash(hash)).toEqual({
      view: "runs",
      projectId: "p 1",
      specId: null,
      planId: null,
      executionId: "exe_1",
      deliveryId: null,
    });
  });

  it("ignores unknown views and empty hashes", () => {
    expect(parseHash("#/nope?project=p1")).toEqual({});
    expect(parseHash("")).toEqual({});
  });

  it("applies a route without dropping an error notice", () => {
    const s = reducer(
      { ...initialState({}), notice: { kind: "error", text: "boom" } },
      { type: "route", route: { view: "plans", planId: "pl1" } },
    );
    expect(s).toMatchObject({ view: "plans", planId: "pl1", notice: { kind: "error" } });
  });
});

describe("notices across navigation (audit S-I5)", () => {
  it("keeps error notices until dismissed, clears info notices", () => {
    const err = reducer(
      { ...initialState({}), notice: { kind: "error", text: "boom" } },
      { type: "navigate", view: "runs" },
    );
    expect(err.notice).toEqual({ kind: "error", text: "boom" });
    const info = reducer(
      { ...initialState({}), notice: { kind: "info", text: "ok" } },
      { type: "navigate", view: "runs" },
    );
    expect(info.notice).toBeNull();
  });
});
