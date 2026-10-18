import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Brokkr } from "@brokkr/sdk";
import { MockExecutor } from "@brokkr/sdk/testing";
import { BrokkrVerifier, loadBrokkrSdk } from "@mimir/brokkr-verifier";
import { afterEach, describe, expect, it } from "vitest";
import { writingRuntime } from "./test-agent-files.js";
import { createTask, harness, setupMission, type Harness } from "./test-harness.js";
import { TestCommandVerifier } from "./verifier.js";
import { RoutingVerifier } from "./verifier-select.js";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Adds the documentation harness's required scripts to the project repo and commits. */
function docsScripts(repo: string): void {
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "demo",
      private: true,
      scripts: {
        test: 'node -e "process.exit(0)"',
        "docs:links": "node -e 0",
        "docs:examples": "node -e 0",
      },
    }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env: { PATH: process.env["PATH"] ?? "", HOME: repo } });
  git("add", "package.json");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "docs");
}

/** Every path under `root` except `.git`, with a content hash for files. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === ".git") continue;
      const p = join(dir, name);
      const rel = p.slice(root.length + 1);
      if (lstatSync(p).isDirectory()) {
        out[rel] = "dir";
        walk(p);
      } else {
        out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

async function run(
  script: Record<string, "passed" | "failed">,
  agentWrites: (cwd: string) => void = () => undefined,
) {
  const sdk = await loadBrokkrSdk();
  if (!sdk) throw new Error("vendored @brokkr/sdk is not installed");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mimir-brokkr-home-")));
  const settings = realpathSync(mkdtempSync(join(tmpdir(), "mimir-brokkr-settings-")));
  dirs.push(home, settings);
  const executor = new MockExecutor(script);
  let dataDir = "";
  let agentDone: { cwd: string; files: Record<string, string> } | undefined;
  const verifier = new RoutingVerifier(
    {
      verify: (input) =>
        new BrokkrVerifier({ sdk, homeDir: home, dataDir, executor }).verify(input),
    },
    new TestCommandVerifier(),
  );
  const h = await harness({
    overrides: { verifier },
    wrapRuntime: (fake) =>
      writingRuntime(fake, (cwd) => {
        // Brokkr blocks package scripts when dependencies are not installed.
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
        agentWrites(cwd);
        agentDone = { cwd, files: snapshot(cwd) };
      }),
  });
  harnesses.push(h);
  dataDir = h.dataDir;
  docsScripts(h.repo);
  const sel = await new Brokkr({ cwd: h.repo, homeDir: home }).resolve({
    task: { id: "plan", title: "t", description: "d" },
    harnesses: [{ name: "documentation", version: "^1" }],
  });
  const lockPath = join(settings, "brokkr.lock.json");
  writeFileSync(lockPath, JSON.stringify(sel.lock));
  const { missionId } = await setupMission(
    h,
    { maxAttemptsPerTask: 1 },
    { verification: { harnesses: ["documentation@^1"], lockPath } },
  );
  const t = await createTask(h, missionId, "Docs", "echo docs");
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(1000);
  await h.idle();
  return { h, t, executor, agentDone: () => agentDone };
}

const artifactOf = (h: Harness, taskId: string, kind: string) => {
  const e = h
    .events(["artifact.recorded"])
    .find((x) => x.taskId === taskId && (x.payload as { kind: string }).kind === kind);
  if (!e) return undefined;
  return JSON.parse(readFileSync(fileURLToPath((e.payload as { uri: string }).uri), "utf8")) as {
    taskId?: string;
    verdict?: string;
    repository?: { commitSha: string };
    headSha?: string;
  };
};

describe("Brokkr verification in the verifying step (T12b)", () => {
  it("a passed verdict completes the task; the report artifact is bound to the task and head", async () => {
    const { h, t, executor, agentDone } = await run({
      "docs-links": "passed",
      "docs-examples": "passed",
    });
    expect(executor.calls.length).toBeGreaterThan(0);
    expect(h.task(t).status).toBe("completed");
    const report = artifactOf(h, t, "brokkr.verification-report");
    const manifest = artifactOf(h, t, "changed-files");
    expect(report?.verdict).toBe("passed");
    expect(report?.taskId).toBe(t);
    expect(report?.repository?.commitSha).toBe(manifest?.headSha);
    // Mimir wrote nothing inside the worktree during the verifying step
    const done = agentDone();
    expect(done).toBeDefined();
    expect(snapshot(done!.cwd)).toEqual(done!.files);
    expect(readdirSync(join(h.dataDir, "brokkr", "runs")).length).toBeGreaterThan(0);
  }, 180_000);

  it("a failed verdict fails the task, and the worktree's own .brokkr cannot waive it (D-012)", async () => {
    const { h, t } = await run({ "docs-links": "passed", "docs-examples": "failed" }, (cwd) => {
      mkdirSync(join(cwd, ".brokkr"), { recursive: true });
      writeFileSync(
        join(cwd, ".brokkr", "exceptions.yaml"),
        "exceptions:\n  - checkId: docs-examples\n    reason: trust me\n",
      );
      writeFileSync(join(cwd, ".brokkr", "config.yaml"), "harnesses: []\n");
    });
    expect(h.task(t).status).toBe("failed");
    expect(h.events(["task.completed"]).filter((e) => e.taskId === t)).toEqual([]);
    expect(artifactOf(h, t, "brokkr.verification-report")?.verdict).toBe("failed");
  }, 180_000);
});
