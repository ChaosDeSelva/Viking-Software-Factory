import { openIntake } from "@sindri/intake";
import { openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Provenance, SpecBody } from "./body.js";
import { renderSpec } from "./render.js";
import { openSpecs, SpecValidationError, type Specs } from "./specs.js";

describe("acceptance criterion ids that are also Object.prototype member names", () => {
  let db: SqliteDatabase;
  let specs: Specs;
  let projectId: string;
  let intakeId: string;

  const body = (ids: string[]): SpecBody => ({
    problem: "Reports cannot be exported.",
    goals: [],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    acceptanceCriteria: ids.map((id) => ({ id, text: `criterion ${id}`, verification: "test" })),
    risks: [],
    openQuestions: [],
  });
  const prov = (acceptanceCriteria: Provenance["acceptanceCriteria"]): Provenance => ({
    problem: [{ intakeId }],
    goals: [],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    risks: [],
    openQuestions: [],
    acceptanceCriteria,
  });

  beforeEach(() => {
    db = openDatabase(":memory:");
    projectId = openKnowledge(db).projects.create({ name: "demo", repoPath: "/tmp/demo" }).id;
    intakeId = openIntake(db).createManual({ projectId, title: "CSV export", body: "pls" }).id;
    specs = openSpecs(db);
  });
  afterEach(() => db.close());

  it.each(["constructor", "hasOwnProperty", "__defineGetter__"])(
    "requires provenance for a criterion named %s",
    (id) => {
      // `{}[id]` is an inherited function with a non-zero `length`, which used to pass for a
      // non-empty list of sources.
      const create = () =>
        specs.createDraft({
          projectId,
          intakeId,
          title: "CSV export",
          body: body([id]),
          provenance: prov({}),
        });
      expect(create).toThrow(SpecValidationError);
      expect(create).toThrow(`provenance for acceptance criterion ${id} must not be empty`);
      expect(specs.listByProject(projectId)).toEqual([]);
    },
  );

  it("accepts and renders such a criterion once it has its own provenance", () => {
    const s = specs.createDraft({
      projectId,
      intakeId,
      title: "CSV export",
      body: body(["constructor"]),
      provenance: prov({ constructor: [{ intakeId }] }),
    });
    expect(specs.render(s.id)).toContain(
      `- **constructor** (test): criterion constructor\n  _Sources: intake:${intakeId}_`,
    );
  });

  it("renders a criterion without its own provenance entry as unsourced", () => {
    const out = renderSpec({
      title: "t",
      version: 1,
      status: "draft",
      approvedBy: null,
      approvedAt: null,
      body: body(["toString", "constructor"]),
      provenance: prov({}),
    });
    expect(out).toContain("- **toString** (test): criterion toString\n  _Sources: none_");
    expect(out).toContain("- **constructor** (test): criterion constructor\n  _Sources: none_");
  });
});
