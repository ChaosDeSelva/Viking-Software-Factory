import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, payloadSchemaFor, type EventType } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifacts.js";
import {
  ARTIFACT_COLLECTION_DIR,
  DEFAULT_COLLECT_LIMITS,
  artifactKindForFile,
  collectArtifactFiles,
  recordCollection,
  type CollectedEmit,
} from "./collect.js";

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mimir-collect-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A worktree with `.mimir/artifacts/` created; returns both paths. */
function worktree(): { root: string; dir: string } {
  const root = tmp();
  const dir = join(root, ARTIFACT_COLLECTION_DIR);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

describe("artifactKindForFile", () => {
  it.each([
    ["review.json", "review"],
    ["screenshot-home.png", "screenshot"],
    ["screenshot-.png", "screenshot"],
    ["test.log", "test.output"],
    ["vitest.out.log", "test.output"],
    ["notes.txt", "file"],
    ["review.json.bak", "file"],
    ["screenshot-home.jpg", "file"],
    ["my-review.json", "file"],
    ["home.png", "file"],
  ])("%s -> %s", (name, kind) => {
    expect(artifactKindForFile(name)).toBe(kind);
  });
});

describe("collectArtifactFiles", () => {
  it("has the agreed default limits", () => {
    expect(DEFAULT_COLLECT_LIMITS).toEqual({
      maxFileBytes: 8 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxFiles: 200,
    });
  });

  it("collects nothing when there is no .mimir/artifacts directory", () => {
    expect(collectArtifactFiles(tmp())).toEqual({ files: [], skipped: [], truncated: null });
  });

  it("reads regular files, sorted by name, with their kinds", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "screenshot-a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, "review.json"), '{"verdict":"approve"}');
    writeFileSync(join(dir, "run.log"), "ok\n");
    const r = collectArtifactFiles(root);
    expect(r.skipped).toEqual([]);
    expect(r.truncated).toBeNull();
    expect(r.files.map((f) => [f.name, f.kind])).toEqual([
      ["review.json", "review"],
      ["run.log", "test.output"],
      ["screenshot-a.png", "screenshot"],
    ]);
    expect(r.files[0]!.content.toString("utf8")).toBe('{"verdict":"approve"}');
  });

  it("refuses a symlink to /etc/passwd without reading it", () => {
    const { root, dir } = worktree();
    symlinkSync("/etc/passwd", join(dir, "passwd.log"));
    const r = collectArtifactFiles(root);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([{ name: "passwd.log", reason: "symlink" }]);
  });

  it("refuses a symlinked .mimir or .mimir/artifacts directory", () => {
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "s3cret");
    const a = tmp();
    symlinkSync(outside, join(a, ".mimir"));
    expect(collectArtifactFiles(a)).toEqual({
      files: [],
      skipped: [{ name: ".mimir", reason: "symlink" }],
      truncated: null,
    });
    const b = tmp();
    mkdirSync(join(b, ".mimir"));
    symlinkSync(outside, join(b, ".mimir", "artifacts"));
    expect(collectArtifactFiles(b)).toEqual({
      files: [],
      skipped: [{ name: ".mimir/artifacts", reason: "symlink" }],
      truncated: null,
    });
  });

  it("skips directories and FIFOs as not_a_file (a FIFO would block a read)", () => {
    const { root, dir } = worktree();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "review.json"), "{}");
    execFileSync("mkfifo", [join(dir, "pipe.log")]);
    const r = collectArtifactFiles(root);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([
      { name: "nested", reason: "not_a_file" },
      { name: "pipe.log", reason: "not_a_file" },
    ]);
  });

  it("skips a file over the per-file limit with its size and the limit", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "big.log"), Buffer.alloc(11));
    writeFileSync(join(dir, "small.log"), Buffer.alloc(10));
    const r = collectArtifactFiles(root, { maxFileBytes: 10, maxTotalBytes: 100, maxFiles: 5 });
    expect(r.files.map((f) => f.name)).toEqual(["small.log"]);
    expect(r.skipped).toEqual([
      { name: "big.log", reason: "file_too_large", bytes: 11, limitBytes: 10 },
    ]);
  });

  it("skips files once the total limit would be exceeded", () => {
    const { root, dir } = worktree();
    for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.log`), Buffer.alloc(6));
    const r = collectArtifactFiles(root, { maxFileBytes: 10, maxTotalBytes: 12, maxFiles: 5 });
    expect(r.files.map((f) => f.name)).toEqual(["a.log", "b.log"]);
    expect(r.skipped).toEqual([
      { name: "c.log", reason: "total_too_large", bytes: 6, limitBytes: 12 },
    ]);
  });

  it("201 entries -> the first 200 by name and a truncation record", () => {
    const { root, dir } = worktree();
    for (let i = 0; i < 201; i++) {
      writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), `${i}`);
    }
    const r = collectArtifactFiles(root);
    expect(r.files).toHaveLength(200);
    expect(r.files[0]!.name).toBe("f000.txt");
    expect(r.files.at(-1)!.name).toBe("f199.txt");
    expect(r.truncated).toEqual({ found: 201, kept: 200, limit: 200 });
  });
});

describe("recordCollection", () => {
  const taskId = newId("tsk");
  const missionId = newId("msn");

  function run(root: string) {
    const store = new ArtifactStore(join(tmp(), "artifacts"));
    const emitted: CollectedEmit[] = [];
    recordCollection(collectArtifactFiles(root), {
      task: { id: taskId, missionId },
      write: (content) => store.write(content),
      emit: (e) => {
        payloadSchemaFor(e.type as EventType).parse(e.payload);
        emitted.push(e);
      },
    });
    return { store, emitted };
  }

  it("records each file as observed from mimir.server, redacted, with a SHA-256 of what is stored", () => {
    const { root, dir } = worktree();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(join(dir, "review.json"), JSON.stringify({ verdict: "approve", note: secret }));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    writeFileSync(join(dir, "screenshot-home.png"), png);
    const { store, emitted } = run(root);
    expect(emitted.map((e) => e.type)).toEqual(["artifact.recorded", "artifact.recorded"]);
    for (const e of emitted) {
      expect(e).toMatchObject({
        provenance: "observed",
        source: "mimir.server",
        streamId: `task:${taskId}`,
        taskId,
        missionId,
      });
    }
    const [review, shot] = emitted.map(
      (e) => e.payload as { artifactId: string; kind: string; name: string; hash: string },
    );
    expect(review).toMatchObject({ kind: "review", name: "review.json" });
    const stored = store.read(review!.artifactId)!;
    expect(stored.toString("utf8")).not.toContain(secret);
    expect(stored.toString("utf8")).toContain("approve");
    expect(review!.hash).toBe(`sha256:${createHash("sha256").update(stored).digest("hex")}`);
    // binary screenshots are stored byte for byte
    expect(shot).toMatchObject({ kind: "screenshot", name: "screenshot-home.png" });
    expect(store.read(shot!.artifactId)).toEqual(png);
  });

  it("emits a reason event per skipped file and one truncation event", () => {
    const { root, dir } = worktree();
    symlinkSync("/etc/passwd", join(dir, "a-passwd.log"));
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}`), "x");
    const { emitted } = run(root);
    const skipped = emitted.filter((e) => e.type === "artifact.collection_skipped");
    expect(skipped.map((e) => e.payload)).toEqual([
      { taskId, name: "a-passwd.log", reason: "symlink" },
    ]);
    const truncated = emitted.filter((e) => e.type === "artifact.collection_truncated");
    expect(truncated.map((e) => e.payload)).toEqual([
      { taskId, found: 201, kept: 200, limit: 200 },
    ]);
    expect(emitted.filter((e) => e.type === "artifact.recorded")).toHaveLength(199);
    expect(readFileSync("/etc/passwd", "utf8").length).toBeGreaterThan(0);
  });
});
