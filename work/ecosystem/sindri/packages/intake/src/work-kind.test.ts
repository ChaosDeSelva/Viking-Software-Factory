import {
  applyMigrations,
  KNOWLEDGE_MIGRATIONS,
  MAX_REQUEST_NOTES_BYTES,
  openDatabase,
  openKnowledge,
} from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import type { Connector, IssueRef } from "./connectors.js";
import { DEFAULT_RESEARCH, IntakeAlreadyImportedError, openIntake } from "./intake.js";
import { INTAKE_MIGRATIONS } from "./schema.js";

describe("intake work kind migration", () => {
  it("keeps rows written before v4 as code changes with no guidance", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
    const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/tmp/p" }).id;
    applyMigrations(db, "intake", INTAKE_MIGRATIONS.slice(0, 3));
    db.prepare(
      `INSERT INTO intakes (id, project_id, source, title, raw_snapshot_json, imported_at, sync_state,
         created_at) VALUES ('old', ?, 'manual', 'Old', ?, 't', 'imported', 't')`,
    ).run(projectId, JSON.stringify({ title: "Old", body: "b", updated: "t", url: null, raw: {} }));
    const intake = openIntake(db);
    expect(intake.get("old")).toMatchObject({
      workKind: "change",
      notes: "",
      skillIds: [],
      research: null,
      linkedExecutionId: null,
    });
    expect(() =>
      db.prepare("UPDATE intakes SET work_kind = 'other' WHERE id = 'old'").run(),
    ).toThrow(/CHECK/);
  });
});

describe("intake work kind", () => {
  const setup = () => {
    const db = openDatabase(":memory:");
    const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/tmp/p" }).id;
    return { intake: openIntake(db), projectId };
  };

  it("stores a research request with default sources, notes and skills", () => {
    const { intake, projectId } = setup();
    const rec = intake.createManual({
      projectId,
      title: "How are retries scheduled?",
      body: "Explain the retry path",
      workKind: "research",
      notes: "Focus on the worker",
      skillIds: ["skl_a", "skl_a", "skl_b"],
      research: { sources: { web: true } },
    });
    expect(rec.workKind).toBe("research");
    expect(rec.research).toEqual({
      sources: { ...DEFAULT_RESEARCH.sources, web: true },
      factCheck: true,
    });
    expect(rec.skillIds).toEqual(["skl_a", "skl_b"]);
    expect(intake.get(rec.id)).toEqual(rec);
  });

  it("defaults to a change and refuses research options on other kinds", () => {
    const { intake, projectId } = setup();
    expect(intake.createManual({ projectId, title: "t", body: "" }).workKind).toBe("change");
    expect(() =>
      intake.createManual({ projectId, title: "t", body: "", research: { factCheck: false } }),
    ).toThrow(/workKind research/);
  });

  it("refuses research with no source, oversized notes and unknown kinds", () => {
    const { intake, projectId } = setup();
    expect(() =>
      intake.createManual({
        projectId,
        title: "t",
        body: "",
        workKind: "research",
        research: { sources: { code: false, feedbackGraph: false, web: false } },
      }),
    ).toThrow(/at least one source/);
    expect(() =>
      intake.createManual({
        projectId,
        title: "t",
        body: "",
        notes: "x".repeat(MAX_REQUEST_NOTES_BYTES + 1),
      }),
    ).toThrow(/notes/);
    expect(() =>
      intake.createManual({ projectId, title: "t", body: "", workKind: "bogus" as never }),
    ).toThrow(/unknown work kind/);
  });

  it("records the execution a follow-up question links to", () => {
    const { intake, projectId } = setup();
    const rec = intake.createManual({
      projectId,
      title: "Follow-up",
      body: "",
      workKind: "research",
      linkedExecutionId: "exe_1",
    });
    expect(rec.linkedExecutionId).toBe("exe_1");
  });
});

describe("re-importing a ticket with work options", () => {
  const connector: Connector = {
    kind: "jira",
    canHandle: () => true,
    parseUrl: (url) => ({ source: "jira", key: "PROJ-1", url }) satisfies IssueRef,
    fetchIssue: () =>
      Promise.resolve({
        source: "jira",
        externalId: "PROJ-1",
        url: "https://jira.test/browse/PROJ-1",
        title: "Why is export slow?",
        body: "",
        updated: "2026-01-01T00:00:00Z",
        raw: {},
      }),
  };
  const setup = () => {
    const db = openDatabase(":memory:");
    const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/tmp/p" }).id;
    return { db, intake: openIntake(db, { connectors: [connector] }), projectId };
  };
  const URL_ = "https://jira.test/browse/PROJ-1";

  it("reports created only for a new row and keeps options when none are sent", async () => {
    const { intake, projectId } = setup();
    const first = await intake.importUrl(URL_, { projectId, notes: "n1" });
    expect(first.created).toBe(true);
    const again = await intake.importUrl(URL_, { projectId });
    expect(again).toMatchObject({ created: false, intake: { id: first.intake.id, notes: "n1" } });
  });

  it("updates changed options while nothing was drafted from the intake", async () => {
    const { intake, projectId } = setup();
    const first = await intake.importUrl(URL_, { projectId });
    const again = await intake.importUrl(URL_, {
      projectId,
      workKind: "research",
      research: { sources: { web: true } },
    });
    expect(again.created).toBe(false);
    expect(again.intake).toMatchObject({
      id: first.intake.id,
      workKind: "research",
      research: { sources: { web: true } },
    });
  });

  it("merges partial research options over the stored ones, not the defaults", async () => {
    const { intake, projectId } = setup();
    await intake.importUrl(URL_, {
      projectId,
      workKind: "research",
      research: { sources: { code: false, web: true, feedbackGraph: false }, factCheck: false },
    });
    const again = await intake.importUrl(URL_, {
      projectId,
      workKind: "research",
      research: { sources: { code: true } },
    });
    expect(again.intake.research).toEqual({
      sources: { code: true, web: true, feedbackGraph: false },
      factCheck: false,
    });
  });

  it("refuses changed options once a spec exists", async () => {
    const { db, intake, projectId } = setup();
    const first = await intake.importUrl(URL_, { projectId });
    db.exec("CREATE TABLE specifications (id TEXT, intake_id TEXT)");
    db.prepare("INSERT INTO specifications VALUES ('s1', ?)").run(first.intake.id);
    const err = await intake
      .importUrl(URL_, { projectId, workKind: "research" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntakeAlreadyImportedError);
    expect((err as IntakeAlreadyImportedError).intakeId).toBe(first.intake.id);
    // The same options as stored are not a change.
    expect((await intake.importUrl(URL_, { projectId, workKind: "change" })).created).toBe(false);
  });
});
