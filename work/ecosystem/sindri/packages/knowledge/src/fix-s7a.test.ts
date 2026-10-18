import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSindriError, SindriError, SINDRI_ERROR_STATUS } from "./errors.js";
import { openKnowledge, type Knowledge } from "./knowledge.js";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return isSindriError(e) ? e.code : `untyped:${String(e)}`;
  }
  return "no-throw";
};

describe("SindriError", () => {
  it("carries a code and an HTTP-style status, recognisable across module copies", () => {
    const e = new SindriError("not_found", "unknown project x");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("not_found");
    expect(e.status).toBe(404);
    expect(SINDRI_ERROR_STATUS).toEqual({
      not_found: 404,
      validation_failed: 422,
      invalid_state: 409,
      no_connector: 422,
    });
    const foreign = Object.assign(new Error("x"), {
      [Symbol.for("sindri.error")]: true,
      code: "invalid_state",
    });
    expect(isSindriError(foreign)).toBe(true);
    expect(isSindriError(new Error("already exists"))).toBe(false);
  });
});

describe("knowledge typed errors, purge and document lookup", () => {
  let k: Knowledge;
  let repo: TempRepo;
  let projectId: string;
  beforeEach(() => {
    repo = createTempRepo({ "README.md": "# Demo\n\nzebracorn marker text\n" });
    k = openKnowledge(":memory:");
    projectId = k.projects.create({ name: "demo", repoPath: repo.path }).id;
  });
  afterEach(() => {
    k.close();
    repo.cleanup();
  });

  it("throws coded errors", () => {
    expect(codeOf(() => k.projects.create({ name: " ", repoPath: "/r" }))).toBe(
      "validation_failed",
    );
    expect(codeOf(() => k.bootstrapProject("nope", { repoPath: repo.path }))).toBe("not_found");
    const add = (over: object) =>
      k.knowledge.add({
        projectId,
        claim: "c",
        sourceRefs: [{ url: "https://x.dev" }],
        confidence: 0.5,
        createdBy: "u",
        ...over,
      });
    expect(codeOf(() => add({ projectId: "nope" }))).toBe("not_found");
    expect(codeOf(() => add({ sourceRefs: [] }))).toBe("validation_failed");
    expect(codeOf(() => add({ sourceRefs: [{ documentId: "d", startLine: 1, endLine: 1 }] }))).toBe(
      "validation_failed",
    );
    const e = add({});
    expect(codeOf(() => k.knowledge.retract(e.id, " "))).toBe("validation_failed");
    expect(codeOf(() => k.knowledge.retract("nope", "r"))).toBe("not_found");
    k.knowledge.retract(e.id, "r");
    expect(codeOf(() => k.knowledge.retract(e.id, "r"))).toBe("invalid_state");
    expect(
      codeOf(() =>
        k.knowledge.supersede(e.id, {
          claim: "c",
          sourceRefs: [{ url: "https://x.dev" }],
          confidence: 1,
          createdBy: "u",
        }),
      ),
    ).toBe("invalid_state");
    expect(
      codeOf(() =>
        k.knowledge.supersede("nope", {
          claim: "c",
          sourceRefs: [{ url: "https://x.dev" }],
          confidence: 1,
          createdBy: "u",
        }),
      ),
    ).toBe("not_found");
  });

  it("looks up documents by id", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    const hit = k.search(projectId, "zebracorn")[0]!;
    expect(k.documents.get(hit.documentId)).toMatchObject({
      id: hit.documentId,
      projectId,
      path: "README.md",
    });
    expect(k.documents.get("nope")).toBeUndefined();
  });

  it("purges a project: rows, FTS index and entries, but refuses with immutable evidence", () => {
    k.bootstrapProject(projectId, { repoPath: repo.path });
    k.knowledge.add({
      projectId,
      claim: "zebracorn claim",
      sourceRefs: [{ url: "https://x.dev" }],
      confidence: 0.5,
      createdBy: "u",
    });
    const other = k.projects.create({ name: "other", repoPath: repo.path });
    k.bootstrapProject(other.id, { repoPath: repo.path });

    k.projects.purge(projectId);
    expect(k.projects.get(projectId)).toBeUndefined();
    const count = (sql: string, ...a: unknown[]) =>
      (k.db.prepare(sql).get(...a) as { n: number }).n;
    expect(count("SELECT count(*) n FROM documents WHERE project_id = ?", projectId)).toBe(0);
    expect(count("SELECT count(*) n FROM knowledge_entries WHERE project_id = ?", projectId)).toBe(
      0,
    );
    // The other project's index is intact and the FTS index is consistent.
    expect(k.search(other.id, "zebracorn")).toHaveLength(1);
    expect(() =>
      k.db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)").run(),
    ).not.toThrow();
    expect(codeOf(() => k.projects.purge(projectId))).toBe("not_found");

    k.evidence.record({ projectId: other.id, externalRef: "x", kind: "k", payload: {} });
    expect(codeOf(() => k.projects.purge(other.id))).toBe("invalid_state");
    expect(k.projects.get(other.id)).toBeDefined();
  });
});
