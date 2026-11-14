import {
  applyMigrations,
  KNOWLEDGE_MIGRATIONS,
  openDatabase,
  openKnowledge,
} from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROPOSAL, MAX_PROPOSAL_REFERENCES, openIntake, WORK_KINDS } from "./intake.js";
import { INTAKE_MIGRATIONS } from "./schema.js";

const snapshot = JSON.stringify({ title: "Old", body: "b", updated: "t", url: null, raw: {} });

describe("proposal work kind migration", () => {
  it("widens work_kind on a database written before proposals, keeping every row", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
    const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/tmp/p" }).id;
    // The last schema before proposals: every migration up to work kinds (v4).
    applyMigrations(db, "intake", INTAKE_MIGRATIONS.slice(0, 4));
    db.prepare(
      `INSERT INTO intakes (id, project_id, source, title, raw_snapshot_json, imported_at,
         sync_state, created_at, work_kind, notes) VALUES
       ('r', ?, 'manual', 'Old', ?, 't', 'imported', 't', 'research', 'kept')`,
    ).run(projectId, snapshot);
    db.prepare(
      `INSERT INTO intake_comments (id, intake_id, author, body, created_at, origin)
       VALUES ('c', 'r', 'a', 'hello', 't', 'local')`,
    ).run();
    expect(() =>
      db.prepare("UPDATE intakes SET work_kind = 'proposal' WHERE id = 'r'").run(),
    ).toThrow(/CHECK/);

    const intake = openIntake(db);
    expect(intake.get("r")).toMatchObject({ workKind: "research", notes: "kept", proposal: null });
    expect(intake.comments("r")).toHaveLength(1);
    db.prepare("UPDATE intakes SET work_kind = 'proposal' WHERE id = 'r'").run();
    expect(() => db.prepare("UPDATE intakes SET work_kind = 'other' WHERE id = 'r'").run()).toThrow(
      /CHECK/,
    );
    // Opening again is a no-op.
    expect(() => openIntake(db)).not.toThrow();
  });
});

describe("proposal work kind", () => {
  const setup = () => {
    const db = openDatabase(":memory:");
    const projects = openKnowledge(db).projects;
    const anchor = projects.create({ name: "app", repoPath: "/tmp/app" }).id;
    const docs = projects.create({ name: "docs", repoPath: "/tmp/docs" }).id;
    const api = projects.create({ name: "api", repoPath: "/tmp/api" }).id;
    return { intake: openIntake(db), anchor, docs, api, projects };
  };

  it("is a work kind", () => {
    expect(WORK_KINDS).toContain("proposal");
  });

  it("stores a plan request with its reference projects and defaults", () => {
    const { intake, anchor, docs, api } = setup();
    const rec = intake.createManual({
      projectId: anchor,
      title: "Plan from the kickoff call",
      body: "We talked about the docs site and the api…",
      workKind: "proposal",
      proposal: { referenceProjectIds: [docs, api, docs] },
    });
    expect(rec.workKind).toBe("proposal");
    expect(rec.proposal).toEqual({ ...DEFAULT_PROPOSAL, referenceProjectIds: [docs, api] });
    expect(rec.research).toBeNull();
    expect(intake.get(rec.id)).toEqual(rec);
  });

  it("takes options left out from the defaults and keeps the ones given", () => {
    const { intake, anchor } = setup();
    const rec = intake.createManual({
      projectId: anchor,
      title: "t",
      body: "text",
      workKind: "proposal",
      proposal: { factCheck: false, sources: { web: true } },
    });
    expect(rec.proposal).toEqual({
      referenceProjectIds: [],
      sources: { code: true, web: true },
      factCheck: false,
    });
  });

  it("refuses unknown, repeated-anchor and too many reference projects", () => {
    const { intake, anchor, projects } = setup();
    const make = (referenceProjectIds: string[]) =>
      intake.createManual({
        projectId: anchor,
        title: "t",
        body: "text",
        workKind: "proposal",
        proposal: { referenceProjectIds },
      });
    expect(() => make(["prj_missing"])).toThrow(/unknown project prj_missing/);
    expect(() => make([anchor])).toThrow(/already the request's project/);
    const many = Array.from(
      { length: MAX_PROPOSAL_REFERENCES + 1 },
      (_, i) => projects.create({ name: `x${i}`, repoPath: `/tmp/x${i}` }).id,
    );
    expect(() => make(many)).toThrow(new RegExp(`at most ${MAX_PROPOSAL_REFERENCES}`));
  });

  it("refuses plan options on other kinds, and a plan with no text or no source", () => {
    const { intake, anchor } = setup();
    expect(() =>
      intake.createManual({ projectId: anchor, title: "t", body: "x", proposal: {} }),
    ).toThrow(/workKind proposal/);
    expect(() =>
      intake.createManual({ projectId: anchor, title: "t", body: "  ", workKind: "proposal" }),
    ).toThrow(/text to plan from/);
    expect(() =>
      intake.createManual({
        projectId: anchor,
        title: "t",
        body: "x",
        workKind: "proposal",
        proposal: { sources: { code: false, web: false } },
      }),
    ).toThrow(/at least one source/);
  });

  it("is created from pasted text, not imported from a ticket", async () => {
    const { intake, anchor } = setup();
    await expect(
      intake.importUrl("https://linear.app/x/issue/ABC-1", {
        projectId: anchor,
        workKind: "proposal",
      }),
    ).rejects.toThrow(/pasted text/);
  });
});
