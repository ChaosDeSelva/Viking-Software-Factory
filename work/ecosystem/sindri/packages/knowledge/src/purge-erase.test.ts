import { describe, expect, it, vi } from "vitest";
import { isSindriError } from "./errors.js";
import { applyMigrations, openDatabase } from "./db.js";
import { openKnowledge, registerPurgeHook } from "./knowledge.js";
import { KNOWLEDGE_MIGRATIONS } from "./schema.js";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return isSindriError(e) ? e.code : `untyped:${String(e)}`;
  }
  return "no-throw";
};

/** Every row of every table as one string (for "nothing mentions X" assertions). */
const dump = (k: ReturnType<typeof openKnowledge>) =>
  (
    k.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map(({ name }) => JSON.stringify(k.db.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");

describe("project purge with task evidence (audit M4)", () => {
  it("refuses without eraseEvidence, and tombstones evidence (id + hash kept) with it", () => {
    const k = openKnowledge(":memory:");
    const p = k.projects.create({ name: "acme", repoPath: "/repos/acme" });
    const keep = k.projects.create({ name: "other", repoPath: "/repos/other" });
    const ev = k.evidence.record({
      projectId: p.id,
      externalRef: "mimir:evt_SEEDED",
      kind: "test_run",
      payload: { text: "SEEDED EVIDENCE TEXT" },
    });
    const kept = k.evidence.record({
      projectId: keep.id,
      externalRef: "mimir:evt_other",
      kind: "test_run",
      payload: { text: "other project text" },
    });
    expect(ev.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(codeOf(() => k.projects.purge(p.id))).toBe("invalid_state");
    k.projects.purge(p.id, { eraseEvidence: true });

    expect(k.projects.get(p.id)).toBeUndefined();
    const all = dump(k);
    for (const marker of [p.id, "SEEDED EVIDENCE TEXT", "evt_SEEDED"])
      expect(all.includes(marker), marker).toBe(false);
    // The tombstone keeps the id and the content hash only.
    expect(k.evidence.get(ev.id)).toBeUndefined();
    expect(k.evidence.erased(ev.id)).toEqual({
      id: ev.id,
      kind: "test_run",
      contentSha256: ev.contentSha256,
      createdAt: ev.createdAt,
      erasedAt: expect.any(String),
    });
    // Other projects' evidence is untouched, and tombstones stay immutable.
    expect(k.evidence.get(kept.id)).toEqual(kept);
    expect(() => k.db.prepare("DELETE FROM task_evidence WHERE id = ?").run(ev.id)).toThrow(
      /immutable/,
    );
    expect(() =>
      k.db.prepare("UPDATE task_evidence SET payload_json = '1' WHERE id = ?").run(ev.id),
    ).toThrow(/immutable/);
    expect(() =>
      k.db.prepare("UPDATE task_evidence SET payload_json = 'null' WHERE id = ?").run(kept.id),
    ).toThrow(/immutable/);
  });

  it("runs the purge hooks other packages register, inside the purge transaction", () => {
    const k = openKnowledge(":memory:");
    const p = k.projects.create({ name: "acme", repoPath: "/repos/acme" });
    k.db.exec("CREATE TABLE side (project_id TEXT, text TEXT)");
    k.db.prepare("INSERT INTO side VALUES (?, 'SIDE TEXT')").run(p.id);
    const hook = vi.fn((projectId: string) => {
      k.db.prepare("DELETE FROM side WHERE project_id = ?").run(projectId);
    });
    registerPurgeHook(k.db, "side", hook);
    registerPurgeHook(k.db, "side", hook); // idempotent per name
    k.projects.purge(p.id);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(p.id);
    expect(dump(k)).not.toContain("SIDE TEXT");

    // A failing hook rolls the whole purge back.
    const q = k.projects.create({ name: "b", repoPath: "/repos/b" });
    registerPurgeHook(k.db, "boom", () => {
      throw new Error("boom");
    });
    expect(() => k.projects.purge(q.id)).toThrow(/boom/);
    expect(k.projects.get(q.id)).toBeDefined();
  });

  it("upgrades a v1 database: existing evidence is kept, hashed on read, and erasable", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS.slice(0, 1));
    db.prepare(
      "INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES ('p1', 'a', '/r', 't', 't')",
    ).run();
    db.prepare(
      `INSERT INTO task_evidence (id, project_id, external_ref, kind, payload_json, created_at)
       VALUES ('ev1', 'p1', 'mimir:evt_1', 'k', '{"x":"LEGACY TEXT"}', 't')`,
    ).run();
    const k = openKnowledge(db);
    const ev = k.evidence.get("ev1")!;
    expect(ev).toMatchObject({ projectId: "p1", payload: { x: "LEGACY TEXT" } });
    expect(ev.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    k.projects.purge("p1", { eraseEvidence: true });
    expect(k.evidence.erased("ev1")?.contentSha256).toBe(ev.contentSha256);
    expect(dump(k)).not.toContain("LEGACY TEXT");
  });
});
