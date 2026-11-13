import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeSessionSpec } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_CONTRACT } from "../templates.js";
import { ARTIFACT_COLLECTION_DIR } from "./collect.js";
import { INPUTS_DIR } from "./inputs.js";
import { DOCUMENT_MISSING, DOCUMENT_MISSING_NOTE, slug } from "./orchestrator.js";
import { FAST_TEST_COMMAND, harness, type Harness, type Json } from "./test-harness.js";

vi.setConfig({ testTimeout: 120_000 });

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123";
const DOCUMENT = { deliverable: "document", access: "read" } as const;

/** One agent session as the fake saw it: its spec, attempt in that worktree and what it found. */
interface Launch {
  spec: RuntimeSessionSpec;
  attempt: number;
  artifacts: string[];
  inputs: Record<string, string>;
}

type Agent = (cwd: string, launch: Launch) => void;

async function setup(
  agent: Agent,
  maxAttemptsPerTask = 1,
): Promise<{ h: Harness; missionId: string; launches: Launch[] }> {
  const launches: Launch[] = [];
  const read = (dir: string, prefix = ""): Record<string, string> => {
    if (!existsSync(dir)) return {};
    const out: Record<string, string> = {};
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) Object.assign(out, read(join(dir, e.name), `${rel}/`));
      else out[rel] = readFileSync(join(dir, e.name), "utf8");
    }
    return out;
  };
  const h = await harness({
    wrapRuntime: (fake) => ({
      capabilities: () => fake.capabilities(),
      health: () => fake.health(),
      createSession: (spec) => {
        const artifactsDir = join(spec.cwd, ARTIFACT_COLLECTION_DIR);
        const launch: Launch = {
          spec,
          attempt: launches.filter((l) => l.spec.cwd === spec.cwd).length + 1,
          artifacts: existsSync(artifactsDir) ? readdirSync(artifactsDir).sort() : [],
          inputs: read(join(spec.cwd, INPUTS_DIR)),
        };
        launches.push(launch);
        mkdirSync(artifactsDir, { recursive: true });
        agent(spec.cwd, launch);
        return fake.createSession(spec);
      },
      listSessions: () => fake.listSessions(),
      getSession: (id) => fake.getSession(id),
      sendInput: (id, input) => fake.sendInput(id, input),
      requestStop: (id, mode) => fake.requestStop(id, mode),
      reconcile: () => fake.reconcile(),
      dispose: () => fake.dispose(),
      subscribe: (handler) => fake.subscribe(handler),
    }),
  });
  harnesses.push(h);
  const p = await h.post("/v1/projects", {
    name: "demo",
    repoPath: h.repo,
    settings: { testCommand: FAST_TEST_COMMAND },
  });
  const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
  await h.post("/v1/crews", {
    missionId: m.json.mission.id,
    template: "solo",
    limits: { maxConcurrentTasks: 2, maxAttemptsPerTask },
    members: [{ role: "implementer", agentKind: "codex" }],
  });
  return { h, missionId: m.json.mission.id as string, launches };
}

async function task(
  h: Harness,
  missionId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await h.post("/v1/tasks", { missionId, title, brief: `Do ${title}`, ...extra });
  expect(res.status).toBe(201);
  return res.json.task.id as string;
}

async function settle(h: Harness, missionId: string, ids: string[]): Promise<void> {
  await h.post(`/v1/missions/${missionId}/start`);
  const done = () =>
    ids.every((id) => {
      const t = h.task(id);
      return t.status === "completed" || (t.status === "failed" && t.attempt + 1 >= t.maxAttempts);
    });
  for (let i = 0; i < 60 && !done(); i++) {
    await h.tick();
    await h.advance(5000);
  }
}

const brief = (l: Launch) => l.spec.argv.at(-1)!;
const worktreeOf = (h: Harness, taskId: string) =>
  [...h.app.mimir.readModel.worktrees.values()].find((w) => w.taskId === taskId)!;
const artifactsOf = (h: Harness, taskId: string, kind?: string) =>
  h
    .events(["artifact.recorded"])
    .filter((e) => e.taskId === taskId)
    .map((e) => e.payload as { kind: string; name?: string; artifactId: string })
    .filter((a) => kind === undefined || a.kind === kind);
const launchesOf = (h: Harness, launches: Launch[], taskId: string) =>
  launches.filter((l) => l.spec.cwd === worktreeOf(h, taskId).path);

describe("slug for input directories", () => {
  it.each([
    ["Research", "research"],
    ["  Fact-check: the API!  ", "fact-check-the-api"],
    ["***", "task"],
    ["a".repeat(70), "a".repeat(60)],
    [`${"a".repeat(59)} b`, "a".repeat(59)],
  ])("%s -> %s", (title, expected) => {
    expect(slug(title, "task", 60)).toBe(expected);
  });
});

describe("dependency inputs in .mimir/inputs/", () => {
  it("copies a document dependency's report and sources, named in the brief, outside diff and result", async () => {
    const { h, missionId, launches } = await setup((cwd, launch) => {
      const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
      if (Object.keys(launch.inputs).length === 0) {
        writeFileSync(join(dir, "research.md"), "# Answer\n\nYes [1].\n");
        writeFileSync(join(dir, "sources.json"), JSON.stringify([{ id: 1, ref: SECRET }]));
        writeFileSync(join(dir, "notes.txt"), "not an input\n");
      } else {
        writeFileSync(join(cwd, "checked.txt"), "fact-checked\n");
      }
    });
    const a = await task(h, missionId, "Research", { mode: DOCUMENT });
    const b = await task(h, missionId, "Fact check", { dependsOn: [a] });
    await settle(h, missionId, [a, b]);
    expect(h.task(a).status).toBe("completed");
    expect(h.task(b).status).toBe("completed");

    const [la] = launchesOf(h, launches, a);
    const [lb] = launchesOf(h, launches, b);
    expect(brief(la!)).toContain(DOCUMENT_CONTRACT);
    expect(brief(la!)).not.toContain(INPUTS_DIR);
    expect(Object.keys(lb!.inputs).sort()).toEqual([
      "research/research.md",
      "research/sources.json",
    ]);
    expect(lb!.inputs["research/research.md"]).toBe("# Answer\n\nYes [1].\n");
    // the stored (redacted) content, not the dependency's worktree
    expect(lb!.inputs["research/sources.json"]).not.toContain(SECRET);
    expect(brief(lb!)).toContain(
      `${INPUTS_DIR}/research/research.md, ${INPUTS_DIR}/research/sources.json`,
    );
    expect(brief(lb!)).not.toContain(DOCUMENT_CONTRACT);

    const requested = h.events(["session.requested"]).find((e) => e.taskId === b)!;
    expect((requested.payload as Json).inputs).toEqual([
      { dependencyTaskId: a, dir: "research", files: ["research.md", "sources.json"] },
    ]);
    expect(
      (h.events(["session.requested"]).find((e) => e.taskId === a)!.payload as Json).inputs,
    ).toBeUndefined();

    const store = h.app.mimir.artifacts;
    const diff = store.read(artifactsOf(h, b, "diff").at(-1)!.artifactId)!.toString("utf8");
    expect(diff).toContain("checked.txt");
    expect(diff).not.toContain(".mimir/inputs");
    const manifest = store.read(artifactsOf(h, b, "changed-files").at(-1)!.artifactId)!;
    expect(manifest.toString("utf8")).not.toContain(".mimir/inputs");
    expect(artifactsOf(h, b).some((x) => x.kind === "report")).toBe(false);
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", h.task(b).resultCommit!], {
      cwd: h.repo,
      encoding: "utf8",
    });
    expect(tree).toContain("checked.txt");
    expect(tree).not.toContain(".mimir");
  });

  it("clears stale artifacts each attempt, tells the retry its report was missing, and hands on only the completing attempt's files", async () => {
    const { h, missionId, launches } = await setup((cwd, launch) => {
      const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
      if (Object.keys(launch.inputs).length > 0) return;
      if (launch.attempt === 1) writeFileSync(join(dir, "sources.json"), "[1]");
      else writeFileSync(join(dir, "research.md"), "# Second try\n");
    }, 2);
    const a = await task(h, missionId, "Research", { mode: DOCUMENT });
    const b = await task(h, missionId, "Fact check", { dependsOn: [a] });
    await settle(h, missionId, [a, b]);
    expect(h.task(a).status).toBe("completed");
    expect(h.task(b).status).toBe("completed");

    const failed = h.events(["task.failed"]).find((e) => e.taskId === a)!;
    expect(failed.payload).toMatchObject({ reason: DOCUMENT_MISSING, retryable: true });
    const [first, second] = launchesOf(h, launches, a);
    expect(brief(first!)).not.toContain(DOCUMENT_MISSING_NOTE);
    expect(brief(second!)).toContain(DOCUMENT_MISSING_NOTE);
    // the first attempt's sources.json was collected, then cleared before the second attempt
    expect(artifactsOf(h, a).map((x) => x.name)).toContain("sources.json");
    expect(second!.artifacts).toEqual([]);
    const [lb] = launchesOf(h, launches, b);
    expect(Object.keys(lb!.inputs)).toEqual(["research/research.md"]);
  });

  it("fails a task whose .mimir is not a directory without retrying it", async () => {
    const { h, missionId, launches } = await setup(() => undefined, 3);
    writeFileSync(join(h.repo, ".mimir"), "not a directory\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: h.repo, stdio: "ignore" });
    git("add", ".mimir");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "mimir file");
    const t = await task(h, missionId, "Solo");
    await settle(h, missionId, [t]);

    expect(h.task(t).status).toBe("failed");
    const failed = h.events(["task.failed"]).filter((e) => e.taskId === t);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      reason: "workspace_invalid: .mimir is not a directory",
      retryable: false,
    });
    expect(h.events(["task.retried"]).filter((e) => e.taskId === t)).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });

  it("leaves a task without dependencies unaffected", async () => {
    const { h, missionId, launches } = await setup(() => undefined);
    const t = await task(h, missionId, "Solo");
    await settle(h, missionId, [t]);
    expect(h.task(t).status).toBe("completed");
    expect(launches[0]!.inputs).toEqual({});
    expect(existsSync(join(worktreeOf(h, t).path, INPUTS_DIR))).toBe(false);
    expect(brief(launches[0]!)).not.toContain(INPUTS_DIR);
    expect(
      (h.events(["session.requested"]).find((e) => e.taskId === t)!.payload as Json).inputs,
    ).toBeUndefined();
  });
});
