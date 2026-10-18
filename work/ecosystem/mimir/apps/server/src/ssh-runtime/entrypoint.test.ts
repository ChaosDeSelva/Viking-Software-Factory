import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it("reports expired jobs consistently for inspect and identical submit without relaunch", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-stale-")));
  roots.push(root);
  const dir = join(root, "jobs", "persisted");
  mkdirSync(dir, { recursive: true });
  const payload = {
    backend: "cli",
    agentKind: "codex",
    argv: ["codex", "hello"],
    taskEnv: {},
    timeoutMs: 1000,
    files: [],
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const entry = fileURLToPath(new URL("../../dist/ssh-runtime/entrypoint.js", import.meta.url));
  for (const state of ["starting", "running", "waiting", "blocked", "stopping"]) {
    const persisted = JSON.stringify({
      state,
      fingerprint,
      updatedAt: new Date(Date.now() - 60000).toISOString(),
    });
    writeFileSync(join(dir, "state.json"), persisted);
    for (const operation of ["inspect", "submit"]) {
      const reply = JSON.parse(
        execFileSync(process.execPath, [entry], {
          env: { ...process.env, MIMIR_REMOTE_ROOT: root },
          encoding: "utf8",
          timeout: 5000,
          input: JSON.stringify({ protocol: 1, root, jobId: "persisted", operation, payload }),
        }),
      );
      expect(reply).toMatchObject({
        ok: true,
        job: { state: "unknown", reason: "worker_heartbeat_lost", fingerprint },
      });
      expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(persisted);
    }
  }
});
