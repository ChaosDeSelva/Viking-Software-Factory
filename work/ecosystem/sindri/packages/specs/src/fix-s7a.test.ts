import { openIntake } from "@sindri/intake";
import { isSindriError, openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Provenance, SpecBody } from "./body.js";
import { openSpecs, SpecStateError, SpecValidationError, type Specs } from "./specs.js";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return isSindriError(e) ? e.code : `untyped:${String(e)}`;
  }
  return "no-throw";
};

describe("specs: coded errors and listByProject", () => {
  let db: SqliteDatabase;
  let specs: Specs;
  let projectId: string;
  let otherId: string;
  let intakeId: string;
  const body = (over: Partial<SpecBody> = {}): SpecBody => ({
    problem: "p",
    goals: [],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC1", text: "t", verification: "test" }],
    risks: [],
    openQuestions: [{ id: "Q1", text: "q", blocking: true }],
    ...over,
  });
  const prov = (): Provenance => ({
    problem: [{ intakeId }],
    goals: [],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    risks: [],
    openQuestions: [],
    acceptanceCriteria: { AC1: [{ intakeId }] },
  });
  beforeEach(() => {
    db = openDatabase(":memory:");
    const k = openKnowledge(db);
    projectId = k.projects.create({ name: "a", repoPath: "/a" }).id;
    otherId = k.projects.create({ name: "b", repoPath: "/b" }).id;
    intakeId = openIntake(db).createManual({ projectId, title: "t", body: "b" }).id;
    specs = openSpecs(db);
  });
  afterEach(() => db.close());

  it("error classes keep their names and carry codes", () => {
    const s = specs.createDraft({ projectId, title: "T", body: body(), provenance: prov() });
    expect(codeOf(() => specs.get("nope") ?? specs.submitForReview("nope"))).toBe("not_found");
    expect(
      codeOf(() =>
        specs.createDraft({ projectId: "nope", title: "T", body: body(), provenance: prov() }),
      ),
    ).toBe("not_found");
    expect(
      codeOf(() => specs.createDraft({ projectId, title: " ", body: body(), provenance: prov() })),
    ).toBe("validation_failed");
    specs.submitForReview(s.id);
    expect(codeOf(() => specs.submitForReview(s.id))).toBe("invalid_state");
    const err = (() => {
      try {
        specs.approve(s.id, { approver: "me" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SpecStateError);
    expect(err).toMatchObject({ name: "SpecStateError", code: "invalid_state", status: 409 });
    expect(new SpecValidationError("x")).toMatchObject({
      name: "SpecValidationError",
      code: "validation_failed",
    });
  });

  it("lists every version of a project's specs in lineage/version order", () => {
    const a = specs.createDraft({ projectId, title: "A", body: body(), provenance: prov() });
    const a2 = specs.revise(a.id, { title: "A2" });
    const b = specs.createDraft({ projectId, title: "B", body: body(), provenance: prov() });
    expect(specs.listByProject(projectId).map((s) => s.id)).toEqual([a.id, a2.id, b.id]);
    expect(specs.listByProject(otherId)).toEqual([]);
  });
});
