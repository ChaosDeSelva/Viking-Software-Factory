import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, serverWorktreeRoot } from "../../src/index.js";
import { TOKEN } from "../../src/test-helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("security: agent worktrees never live inside the data dir (audit H1)", () => {
  it("defaults to a sibling of the data dir, never <data>/worktrees", () => {
    expect(serverWorktreeRoot("/srv/mimir")).toBe("/srv/mimir-worktrees");
    expect(serverWorktreeRoot("/srv/mimir", "/elsewhere/wt")).toBe("/elsewhere/wt");
  });

  it("refuses an explicit worktree root inside the data dir", () => {
    expect(() => serverWorktreeRoot("/srv/mimir", "/srv/mimir/worktrees")).toThrow(/data dir/);
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-wt-root-")));
    dirs.push(dataDir);
    const store = openEventStore(":memory:");
    try {
      expect(() =>
        buildServer({
          store,
          ledger: store.commands,
          audit: store.audit,
          runtime: null,
          authToken: TOKEN,
          dataDir,
          worktreeRoot: join(dataDir, "worktrees"),
        }),
      ).toThrow(/data dir/);
    } finally {
      store.close();
    }
  });
});
