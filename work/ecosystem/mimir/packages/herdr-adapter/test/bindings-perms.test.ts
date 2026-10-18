import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileBindingStore } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("JsonFileBindingStore file modes (audit L6)", () => {
  it("creates a missing data dir 0700 and the bindings file 0600, even under umask 0", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mimir-bind-"));
    dirs.push(root);
    const file = path.join(root, "data", "herdr-bindings.json");
    const old = process.umask(0);
    try {
      await new JsonFileBindingStore(file).put({
        sessionId: "ses_a",
        idempotencyKey: "k",
        paneId: "w1:p1",
        workspaceId: "w1",
        cwd: "/tmp",
        agentKind: "shell",
        createdAt: new Date(0).toISOString(),
      });
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
