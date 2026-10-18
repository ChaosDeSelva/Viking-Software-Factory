import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { bindTranscript, foldTranscript, observeTranscript } from "./transcripts.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const run = (id: string, kind: string) => ({
  payload: { kind: "run", run_id: id, event: { kind } },
});
it("folds Cursor boundaries without treating assistant content or nested events as completion", () => {
  expect(
    foldTranscript(
      "cursor",
      jsonl({ role: "user" }, { role: "assistant", content: { type: "turn_ended" } }),
    ),
  ).toBe("running");
  expect(
    foldTranscript("cursor", jsonl({ role: "user" }, { type: "turn_ended", status: "aborted" })),
  ).toBe("waiting");
  expect(foldTranscript("cursor", jsonl({ type: "turn_ended" }))).toBeUndefined();
  expect(foldTranscript("cursor", jsonl({ role: "user" }) + '{"type":')).toBeUndefined();
  expect(foldTranscript("cursor", jsonl({ role: "user" }) + "bad\n")).toBeUndefined();
});
it("tracks all Muse runs and ignores nested terminal records", () => {
  expect(
    foldTranscript("muse", jsonl(run("a", "started"), run("b", "started"), run("a", "terminal"))),
  ).toBe("running");
  expect(
    foldTranscript(
      "muse",
      jsonl(run("a", "started"), { payload: { record: { kind: "terminal" } } }),
    ),
  ).toBe("running");
  expect(foldTranscript("muse", jsonl(run("a", "started"), run("a", "terminal")))).toBe("waiting");
  expect(foldTranscript("muse", jsonl(run("unknown", "terminal")))).toBeUndefined();
});
it("binds one new exact-workspace Cursor conversation and invalidates old idle across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-transcript-"));
  roots.push(root);
  const project = join(root, "lossy-slug");
  mkdirSync(project);
  writeFileSync(join(project, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  const add = (id: string) => {
    const dir = join(project, "agent-transcripts", id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, id + ".jsonl");
    writeFileSync(file, jsonl({ role: "user" }, { type: "turn_ended" }));
    return file;
  };
  add("old");
  const binding = bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: root })!;
  expect(observeTranscript(binding)).toBeUndefined();
  const file = add("new");
  const idle = observeTranscript(binding)!;
  expect(idle.state).toBe("waiting");
  binding.ignored = idle.fingerprint;
  appendFileSync(file, jsonl({ role: "assistant", content: "late bookkeeping" }));
  expect(observeTranscript(JSON.parse(JSON.stringify(binding)))).toBeUndefined();
  appendFileSync(file, jsonl({ role: "user" }));
  expect(observeTranscript(binding)?.state).toBe("running");
  add("ambiguous");
  expect(observeTranscript(binding)).toBeUndefined();
  expect(
    observeTranscript(
      bindTranscript("cursor", "/task/nested", { MIMIR_CURSOR_PROJECTS_ROOT: root })!,
    ),
  ).toBeUndefined();
});
it("uses Muse main logs only and excludes pre-launch sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-muse-"));
  roots.push(root);
  const add = (name: string) => {
    const dir = join(root, "2026", "10", "15", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "session.jsonl"),
      jsonl(
        { payload: { record: { workspace_root: "/task" } } },
        run(name, "started"),
        run(name, "terminal"),
      ),
    );
    return dir;
  };
  add("old");
  const binding = bindTranscript("muse", "/task", { MIMIR_MUSE_SESSIONS_ROOT: root })!;
  expect(observeTranscript(binding)).toBeUndefined();
  const dir = add("new");
  const child = join(dir, "subagent", "child");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, "session.jsonl"), jsonl(run("child", "started")));
  expect(observeTranscript(binding)?.state).toBe("waiting");
});
