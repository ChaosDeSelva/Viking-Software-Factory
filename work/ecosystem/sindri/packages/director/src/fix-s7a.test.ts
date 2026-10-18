import { isSindriError, openKnowledge } from "@sindri/knowledge";
import { openIntake } from "@sindri/intake";
import { openSpecs } from "@sindri/specs";
import { describe, expect, it } from "vitest";
import { DirectorError, openDirector } from "./director.js";
import { NullProvider } from "./providers/null.js";

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return isSindriError(e) ? e.code : `untyped:${String(e)}`;
  }
  return "no-throw";
};

describe("director coded errors", () => {
  it("maps unknown ids to not_found, stale versions to invalid_state, empty answers to validation_failed", async () => {
    const k = openKnowledge(":memory:");
    const projectId = k.projects.create({ name: "p", repoPath: "/r" }).id;
    const intakeId = openIntake(k.db).createManual({ projectId, title: "t", body: "b" }).id;
    const specs = openSpecs(k.db);
    const d = openDirector(k.db, { provider: new NullProvider() });
    const spec = specs.createDraft({
      projectId,
      intakeId,
      title: "T",
      body: {
        problem: "p",
        goals: [],
        nonGoals: [],
        constraints: [],
        assumptions: [],
        acceptanceCriteria: [],
        risks: [],
        openQuestions: [{ id: "Q1", text: "q?", blocking: true }],
      },
      provenance: {
        problem: [{ intakeId }],
        goals: [],
        nonGoals: [],
        constraints: [],
        assumptions: [],
        risks: [],
        openQuestions: [],
        acceptanceCriteria: {},
      },
    });
    expect(new DirectorError("x")).toMatchObject({ name: "DirectorError", code: "invalid_state" });
    expect(await codeOf(() => d.questions("nope"))).toBe("not_found");
    expect(await codeOf(() => d.answer("nope", "Q1", "a"))).toBe("not_found");
    expect(await codeOf(() => d.answer(spec.id, "Q9", "a"))).toBe("not_found");
    expect(await codeOf(() => d.answer(spec.id, "Q1", "  "))).toBe("validation_failed");
    d.answer(spec.id, "Q1", "yes");
    expect(await codeOf(() => d.answer(spec.id, "Q1", "again"))).toBe("invalid_state");
    expect(await codeOf(() => d.draftSpec({ projectId: "nope", request: "x" }))).toBe("not_found");
    expect(await codeOf(() => d.draftSpec({ projectId, intakeId: "nope", request: "x" }))).toBe(
      "not_found",
    );
    k.close();
  });
});
