import { applyMigrations, openDatabase, openKnowledge } from "@sindri/knowledge";
import { describe, expect, it, vi } from "vitest";
import type { Connector } from "./connectors.js";
import { openIntake } from "./intake.js";
import { INTAKE_MIGRATIONS } from "./schema.js";
import * as sanitize from "./sanitize.js";

vi.mock("./sanitize.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sanitize.js")>();
  return { ...real, sanitizeForDisplay: vi.fn(real.sanitizeForDisplay) };
});
const spy = vi.mocked(sanitize.sanitizeForDisplay);

const RLO = "‮";
const TITLE = `Invoice${RLO}fdp.exe <b>bold</b>`;
const BODY = `see <script>alert(1)</script> here`;

const setup = (connectors: Connector[] = []) => {
  const db = openDatabase(":memory:");
  const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/r" }).id;
  return { db, projectId, intake: openIntake(db, { connectors }) };
};

const fakeConnector = (title: string, body: string, updated: string): Connector => ({
  kind: "jira",
  canHandle: () => true,
  parseUrl: (url) => ({ source: "jira", key: "PROJ-1", url }),
  fetchIssue: () =>
    Promise.resolve({
      source: "jira",
      externalId: "PROJ-1",
      url: "https://acme.atlassian.net/browse/PROJ-1",
      title,
      body,
      updated,
      raw: {},
    }),
  fetchComments: () =>
    Promise.resolve({
      comments: [{ externalId: "c1", author: `Eve${RLO}`, body: BODY, createdAt: "t" }],
      raw: {},
    }),
});

describe("intake display text is sanitized once, at write time (audit M5)", () => {
  it("stores display fields for manual intakes and local comments; reads never re-sanitize", () => {
    const { intake, projectId, db } = setup();
    const rec = intake.createManual({ projectId, title: TITLE, body: BODY });
    expect(rec.display).toEqual({ title: "Invoicefdp.exe bold", body: "see  here" });
    const note = intake.annotate(rec.id, { author: `Mal${RLO}`, body: "<i>hi</i>" });
    expect(note.display).toEqual({ author: "Mal", body: "hi" });
    expect(
      db.prepare("SELECT display_title, display_body FROM intakes WHERE id = ?").get(rec.id),
    ).toEqual({ display_title: "Invoicefdp.exe bold", display_body: "see  here" });

    spy.mockClear();
    expect(intake.get(rec.id)!.display).toEqual(rec.display);
    expect(intake.list(projectId)[0]!.display).toEqual(rec.display);
    expect(intake.comments(rec.id)[0]!.display).toEqual({ author: "Mal", body: "hi" });
    expect(spy).not.toHaveBeenCalled();
    // The stored ticket text itself is untouched.
    expect(intake.get(rec.id)!.title).toBe(TITLE);
    expect(intake.get(rec.id)!.body).toBe(BODY);
  });

  it("stores display fields for imported tickets, their comments and adopted remote updates", async () => {
    const first = fakeConnector(TITLE, BODY, "v1");
    const { intake, projectId, db } = setup([first]);
    const rec = await intake.importFromUrl("https://acme.atlassian.net/browse/PROJ-1", {
      projectId,
    });
    expect(rec.display.title).toBe("Invoicefdp.exe bold");
    expect(intake.comments(rec.id)[0]!.display).toEqual({ author: "Eve", body: "see  here" });

    const second = openIntake(db, { connectors: [fakeConnector("<u>New</u> title", "new", "v2")] });
    await second.importFromUrl("https://acme.atlassian.net/browse/PROJ-1", { projectId });
    const resolved = second.resolveSync(rec.id, { take: "remote" });
    expect(resolved.display).toEqual({ title: "New title", body: "new" });
  });

  it("backfills display fields for rows written before they existed", () => {
    const db = openDatabase(":memory:");
    const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/r" }).id;
    applyMigrations(db, "intake", INTAKE_MIGRATIONS.slice(0, 2));
    db.prepare(
      `INSERT INTO intakes (id, project_id, source, title, raw_snapshot_json, imported_at,
         sync_state, created_at)
       VALUES ('i1', ?, 'manual', ?, ?, 't', 'imported', 't')`,
    ).run(projectId, TITLE, JSON.stringify({ title: TITLE, body: BODY, updated: "t", url: null }));
    db.prepare(
      `INSERT INTO intake_comments (id, intake_id, author, body, created_at, origin)
       VALUES ('c1', 'i1', 'Bob', ?, 't', 'local')`,
    ).run(BODY);
    const intake = openIntake(db);
    spy.mockClear();
    expect(intake.get("i1")!.display).toEqual({ title: "Invoicefdp.exe bold", body: "see  here" });
    expect(intake.comments("i1")[0]!.display).toEqual({ author: "Bob", body: "see  here" });
    expect(spy).not.toHaveBeenCalled();
  });
});
