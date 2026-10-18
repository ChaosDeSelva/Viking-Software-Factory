import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "./reducer.js";

const base = (over: Partial<State> = {}): State => ({ ...initialState({}), ...over });

describe("store reducer: plans, runs and deliveries", () => {
  it("starts with nothing selected", () => {
    expect(initialState({})).toMatchObject({ planId: null, executionId: null, deliveryId: null });
  });

  it("opens a plan, an execution and a delivery on their screens", () => {
    expect(reducer(base(), { type: "plan/open", planId: "pl1" })).toMatchObject({
      view: "plans",
      planId: "pl1",
    });
    expect(reducer(base(), { type: "execution/open", executionId: "e1" })).toMatchObject({
      view: "runs",
      executionId: "e1",
    });
    expect(reducer(base(), { type: "delivery/open", deliveryId: "e1" })).toMatchObject({
      view: "deliveries",
      deliveryId: "e1",
    });
  });

  it("navigates to the new views", () => {
    for (const view of ["plans", "harnesses", "runs", "reviews", "deliveries"] as const)
      expect(reducer(base(), { type: "navigate", view }).view).toBe(view);
  });

  it("clears project-scoped selections when the project changes or is removed", () => {
    const s = base({
      projectId: "p1",
      projects: [],
      planId: "pl1",
      executionId: "e1",
      deliveryId: "e1",
    });
    expect(reducer(s, { type: "project/select", projectId: "p2" })).toMatchObject({
      planId: null,
      executionId: null,
      deliveryId: null,
    });
    expect(reducer(s, { type: "projects/remove", projectId: "p1" })).toMatchObject({
      planId: null,
      executionId: null,
      deliveryId: null,
    });
  });
});
