import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./reducer.js";

const base = (over: Partial<State> = {}): State => ({ ...initialState({}), ...over });

describe("store reducer", () => {
  it("starts on the Overview without a token, honouring the given token", () => {
    expect(initialState({})).toMatchObject({ token: null, view: "overview", projectId: null });
    expect(initialState({ token: "abc" })).toMatchObject({ token: "abc" });
  });

  it("sets and clears the token", () => {
    const s = reducer(base(), { type: "token/set", token: "t1" });
    expect(s.token).toBe("t1");
    expect(reducer(s, { type: "token/clear" }).token).toBeNull();
  });

  it("navigates between views and clears the notice", () => {
    const s = reducer(base({ notice: { kind: "info", text: "x" } }), {
      type: "navigate",
      view: "settings",
    });
    expect(s.view).toBe("settings");
    expect(s.notice).toBeNull();
  });

  it("selects a project and resets project-scoped selections", () => {
    const s = reducer(base({ specId: "s1" }), { type: "project/select", projectId: "p1" });
    expect(s).toMatchObject({ projectId: "p1", specId: null });
  });

  it("stores projects, upserts and auto-selects the first when none is selected", () => {
    const p1 = { id: "p1", name: "A", repoPath: "/a" };
    const p2 = { id: "p2", name: "B", repoPath: "/b" };
    let s = reducer(base(), { type: "projects/loaded", projects: [p1] });
    expect(s.projects).toEqual([p1]);
    expect(s.projectId).toBe("p1");
    expect(reducer(base(), { type: "projects/upsert", project: p2 }).projectId).toBe("p2");
    s = reducer(s, { type: "projects/upsert", project: p2 });
    expect(s.projects).toEqual([p1, p2]);
    s = reducer(s, { type: "projects/upsert", project: { ...p1, name: "A2" } });
    expect(s.projects.map((p) => p.name)).toEqual(["A2", "B"]);
    s = reducer(s, { type: "projects/remove", projectId: "p1" });
    expect(s.projects).toEqual([p2]);
    expect(s.projectId).toBe("p2");
  });

  it("opens a spec in the specs view", () => {
    const s = reducer(base(), { type: "spec/open", specId: "s9" });
    expect(s).toMatchObject({ view: "specs", specId: "s9" });
  });

  it("shows and dismisses notices", () => {
    const s = reducer(base(), { type: "notice", notice: { kind: "error", text: "boom" } });
    expect(s.notice).toEqual({ kind: "error", text: "boom" });
    expect(reducer(s, { type: "notice/dismiss" }).notice).toBeNull();
  });

  it("opens a docs page at a section", () => {
    expect(
      reducer(base(), { type: "docs/open", slug: "glossary", section: "steward" }),
    ).toMatchObject({ view: "docs", docsSlug: "glossary", docsSection: "steward" });
  });

  it("an unauthorized error clears the token and explains why", () => {
    const s = reducer(base({ token: "old" }), { type: "auth/rejected" });
    expect(s.token).toBeNull();
    expect(s.notice?.kind).toBe("error");
  });

  it("keeps the selected project and its selections when another project is added or removed", () => {
    const p1 = { id: "p1", name: "A", repoPath: "/a" };
    const p2 = { id: "p2", name: "B", repoPath: "/b" };
    const s = base({ projects: [p1], projectId: "p1", specId: "s1", planId: "pl1" });
    const added = reducer(s, { type: "projects/upsert", project: p2 });
    expect(added).toMatchObject({ projectId: "p1", specId: "s1", planId: "pl1" });
    const removed = reducer(added, { type: "projects/remove", projectId: "p2" });
    expect(removed.projects).toEqual([p1]);
    expect(removed).toMatchObject({ projectId: "p1", specId: "s1", planId: "pl1" });
    // Removing the last project leaves none selected.
    expect(reducer(removed, { type: "projects/remove", projectId: "p1" })).toMatchObject({
      projects: [],
      projectId: null,
      specId: null,
      planId: null,
    });
  });
});
