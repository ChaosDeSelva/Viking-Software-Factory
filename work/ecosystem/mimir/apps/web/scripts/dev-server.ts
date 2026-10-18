/**
 * E2E harness: a real Mimir server (`buildServer`) with an in-memory store and FakeRuntime on
 * loopback, plus a throwaway git repo with a passing `test` script.
 *
 * Enabled at integration: it needs the T6 `buildServer(opts)` signature and the T12
 * orchestration routes. Until then `MIMIR_E2E` stays unset and the flow spec is skipped.
 *
 * Also starts a tiny loopback-only *control* server (test-only, never part of Mimir) so the spec can
 * seed tasks: the UI has no task editor, so the harness creates them through `POST /v1/tasks`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { FakeRuntime } from "@mimir/fake-runtime";
import type { MissionId, TaskId } from "@mimir/protocol";
import { buildServer } from "@mimir/server";

const port = Number(process.env["MIMIR_E2E_PORT"] ?? 7711);
const controlPort = port + 1;
// Test-only token (the server requires >= 32 chars in config); never printed.
const token = process.env["MIMIR_E2E_TOKEN"] ?? "e2e-token-e2e-token-e2e-token-e2e-token";

const root = mkdtempSync(join(tmpdir(), "mimir-e2e-"));
/** A throwaway git repo with a passing `test` script. One project per repo, so each spec gets its own. */
function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@localhost");
  git("config", "user.name", "e2e");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "e2e-repo", scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
  );
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}
const repo = makeRepo("repo");
const liveRepo = makeRepo("live-repo");

process.env["MIMIR_DATA_DIR"] = join(root, "data");
process.env["MIMIR_TICK_MS"] ??= "200";

const store = openEventStore(":memory:");
const runtime = new FakeRuntime();
// FakeRuntime runs on a manual clock; drive it in real time so sessions progress.
const tick = setInterval(() => runtime.clock.advance(50), 50);

const app = buildServer({
  store,
  ledger: store.commands,
  audit: store.audit,
  runtime,
  authToken: token,
  allowedRoots: [root],
  // The flow's task C (`rm -rf build`) is destructive: deny by default, so let it through with an
  // operator approval, which is what the flow exercises.
  policies: [{ id: "e2e#destructive", action: "shell.destructive", effect: "require_approval" }],
  // The Vite dev origin, passed explicitly through config (the Host check is untouched).
  allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
});
await app.listen({ host: "127.0.0.1", port });

interface SeedTask {
  key: string;
  title: string;
  acceptance: string;
  dependsOn?: string[];
}

/**
 * Seeds tasks through the real API (`POST /v1/tasks`): the acceptance text is the task brief, so
 * for the shell crew it is the command the session runs (and the policy gate classifies).
 */
async function seed(missionId: MissionId, crewId: string | null, tasks: SeedTask[]) {
  const ids = new Map<string, TaskId>();
  for (const t of tasks) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `seed-${missionId}-${t.key}`,
      },
      body: JSON.stringify({
        missionId,
        ...(crewId ? { crewId } : {}),
        title: t.title,
        brief: t.acceptance,
        acceptanceCriteria: [t.acceptance],
        dependsOn: (t.dependsOn ?? []).map((k) => ids.get(k) as TaskId),
      }),
    });
    if (res.status !== 201) throw new Error(`seed ${t.key}: ${res.status} ${await res.text()}`);
    ids.set(t.key, ((await res.json()) as { task: { id: TaskId } }).task.id);
  }
  return ids;
}

const control = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/seed-tasks") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString("utf8")));
  req.on("end", () => {
    const { missionId, crewId, tasks } = JSON.parse(body) as {
      missionId: MissionId;
      crewId: string | null;
      tasks: SeedTask[];
    };
    seed(missionId, crewId, tasks).then(
      (ids) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(Object.fromEntries(ids))),
      (e: unknown) => res.writeHead(400).end(String(e)),
    );
  });
});
control.listen(controlPort, "127.0.0.1");

const info = {
  baseUrl: `http://127.0.0.1:${port}`,
  controlUrl: `http://127.0.0.1:${controlPort}`,
  token,
  repoPath: repo,
  liveRepoPath: liveRepo,
};
const infoPath = process.env["MIMIR_E2E_INFO"] ?? join(root, "info.json");
writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
console.log(`MIMIR_E2E_READY info=${infoPath}`);

const shutdown = async () => {
  clearInterval(tick);
  control.close();
  await app.close();
  store.close?.();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
