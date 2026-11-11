import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  appendFileSync,
  symlinkSync,
} from "node:fs";
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
it("rejects malformed rows, unknown runs and logs without a started turn", () => {
  expect(foldTranscript("cursor", jsonl({ role: "user" }, 1))).toBeUndefined();
  expect(foldTranscript("cursor", jsonl({ role: "user" }, null))).toBeUndefined();
  expect(foldTranscript("muse", jsonl([run("a", "started")]))).toBeUndefined();
  expect(
    foldTranscript(
      "muse",
      jsonl({ payload: { kind: "run", run_id: "", event: { kind: "started" } } }),
    ),
  ).toBeUndefined();
  expect(foldTranscript("muse", jsonl({ payload: { kind: "run", run_id: "a" } }))).toBeUndefined();
  // Progress events inside a run neither open nor close it.
  expect(foldTranscript("muse", jsonl(run("a", "started"), run("a", "progress")))).toBe("running");
  expect(
    foldTranscript("muse", jsonl({ payload: { record: { workspace_root: "/task" } } })),
  ).toBeUndefined();
});
it("resolves default session roots from the launch environment", () => {
  const home = mkdtempSync(join(tmpdir(), "mimir-transcript-home-"));
  roots.push(home);
  expect(bindTranscript("codex", "/task", { HOME: home })).toBeUndefined();
  expect(bindTranscript("cursor", "/task", { HOME: home })).toEqual({
    kind: "cursor",
    root: join(home, ".cursor", "projects"),
    workspace: "/task",
    prior: [],
  });
  expect(bindTranscript("muse", "/task", { HOME: home })?.root).toBe(
    join(home, ".local", "share", "muse", "sessions"),
  );
  expect(
    bindTranscript("muse", "/task", { HOME: home, XDG_DATA_HOME: join(home, "data") })?.root,
  ).toBe(join(home, "data", "muse", "sessions"));
});
it("refuses to bind when the baseline cannot be established", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-transcript-"));
  roots.push(root);
  const file = join(root, "not-a-directory");
  writeFileSync(file, "");
  expect(() => bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: file })).toThrow();
  const project = join(root, "bad");
  mkdirSync(project);
  writeFileSync(join(project, ".workspace-trusted"), "{not json");
  expect(() => bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: root })).toThrow(
    SyntaxError,
  );
  writeFileSync(join(project, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  const twin = join(root, "twin");
  mkdirSync(twin);
  writeFileSync(join(twin, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  expect(() => bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: root })).toThrow(
    "Ambiguous workspace identity",
  );
  // A redirected trust marker is not read through.
  rmSync(join(twin, ".workspace-trusted"));
  symlinkSync(join(project, ".workspace-trusted"), join(twin, ".workspace-trusted"));
  expect(() => bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: root })).toThrow(
    "Unsupported transcript file",
  );
});
it("bounds the size of a session namespace", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-transcript-"));
  roots.push(root);
  for (let n = 0; n <= 10000; n++) writeFileSync(join(root, String(n)), "");
  expect(() => bindTranscript("muse", "/task", { MIMIR_MUSE_SESSIONS_ROOT: root })).toThrow(
    "Transcript namespace exceeds bound",
  );
}, 120000);
it("bounds the number of Muse session directories across levels", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-transcript-"));
  roots.push(root);
  // 101 × 100 directories at the second level exceed the bound without any one level doing so.
  for (let a = 0; a <= 100; a++)
    for (let b = 0; b < 100; b++) mkdirSync(join(root, String(a), String(b)), { recursive: true });
  expect(() => bindTranscript("muse", "/task", { MIMIR_MUSE_SESSIONS_ROOT: root })).toThrow(
    "Transcript namespace exceeds bound",
  );
}, 120000);
it("does not observe an unfinished line, an oversized log or an ambiguous workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-transcript-"));
  roots.push(root);
  const project = join(root, "slug");
  mkdirSync(project);
  writeFileSync(join(project, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  const binding = bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: root })!;
  const dir = join(project, "agent-transcripts", "new");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "new.jsonl");
  writeFileSync(file, jsonl({ role: "user" }) + '{"type":"turn_');
  expect(observeTranscript(binding)).toBeUndefined();
  writeFileSync(file, jsonl({ role: "user" }) + " ".repeat(8 * 1024 * 1024) + "\n");
  expect(observeTranscript(binding)).toBeUndefined();
  writeFileSync(file, jsonl({ role: "user" }));
  expect(observeTranscript(binding)?.state).toBe("running");
  const twin = join(root, "twin");
  mkdirSync(twin);
  writeFileSync(join(twin, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  expect(observeTranscript(binding)).toBeUndefined();
});
it("skips projects without a trust marker and logs without a user turn", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-transcript-"));
  roots.push(root);
  mkdirSync(join(root, "untrusted", "agent-transcripts", "foreign"), { recursive: true });
  const project = join(root, "slug");
  mkdirSync(project);
  writeFileSync(join(project, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  const binding = bindTranscript("cursor", "/task", { MIMIR_CURSOR_PROJECTS_ROOT: root })!;
  expect(binding.prior).toEqual([]);
  const dir = join(project, "agent-transcripts", "new");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "new.jsonl"), jsonl({ role: "assistant", content: "hello" }));
  expect(observeTranscript(binding)).toBeUndefined();
});
it("bounds a log by its decoded size, not only its size on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "mimir-muse-"));
  roots.push(root);
  const dir = join(root, "2026", "10", "15", "session");
  mkdirSync(dir, { recursive: true });
  // Each invalid byte decodes to a three-byte replacement character.
  writeFileSync(join(dir, "session.jsonl"), Buffer.alloc(3 * 1024 * 1024, 0xff));
  expect(() => bindTranscript("muse", "/task", { MIMIR_MUSE_SESSIONS_ROOT: root })).toThrow(
    "Transcript exceeds bound",
  );
});
