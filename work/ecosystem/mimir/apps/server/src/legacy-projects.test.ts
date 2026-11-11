import { openEventStore } from "@mimir/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyProjects } from "./legacy-projects.js";
import { ReadModel } from "./readmodel.js";
import { tempGitRepo } from "./test-helpers.js";

let tmp: ReturnType<typeof tempGitRepo>;
beforeEach(() => {
  tmp = tempGitRepo();
});
afterEach(() => tmp.cleanup());

const project = (n: number) => ({
  id: `prj_01J0000000000000000000000${n}`,
  name: `legacy-${n}`,
  repoPath: `${tmp.repo}-${n}`,
  settings: {},
  createdAt: `2026-01-0${n}T00:00:00.000Z`,
  updatedAt: `2026-01-0${n}T00:00:00.000Z`,
  version: 0,
});

describe("migrateLegacyProjects", () => {
  it("does nothing without the legacy table", () => {
    const store = openEventStore(":memory:");
    const rm = ReadModel.load(store);
    expect(migrateLegacyProjects(store, rm, new Date())).toBe(0);
    store.close();
  });

  // Regression: one unparseable row (JSON.parse threw) made every boot fail; a row that parses
  // but fails the schema was already skipped. Both are now skipped and the rest migrated.
  it("skips unreadable rows instead of failing the boot", () => {
    const store = openEventStore(":memory:");
    const db = store.connection();
    db.exec(`CREATE TABLE server_projects (
      id TEXT PRIMARY KEY, repo_path TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const insert = db.prepare("INSERT INTO server_projects VALUES (?, ?, ?, ?)");
    const good = [project(1), project(3)];
    insert.run(good[0]?.id, "a", JSON.stringify(good[0]), "2026-01-01");
    insert.run("prj_corrupt", "b", "{not json", "2026-01-02");
    insert.run("prj_invalid", "c", JSON.stringify({ id: "nope" }), "2026-01-03");
    insert.run(good[1]?.id, "d", JSON.stringify(good[1]), "2026-01-04");
    const rm = ReadModel.load(store);
    expect(migrateLegacyProjects(store, rm, new Date())).toBe(2);
    expect([...rm.projects.values()]).toEqual(good);
    // Exactly once: a second run (next boot) migrates nothing.
    expect(migrateLegacyProjects(store, rm, new Date())).toBe(0);
    store.close();
  });
});
