import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifacts.js";
import {
  ARTIFACT_COLLECTION_DIR,
  DEFAULT_COLLECT_LIMITS,
  collectArtifactFiles,
  recordCollection,
  type CollectedEmit,
} from "./collect.js";

// The file system calls the collector makes, wrapped so a test can simulate what a concurrent
// writer (the agent, still running) or an unreadable entry does between two of them.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readdirSync: vi.fn(actual.readdirSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

const dirs: string[] = [];
const real = await vi.importActual<typeof import("node:fs")>("node:fs");
afterEach(() => {
  reset();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const reset = () => {
  vi.mocked(fs.fstatSync).mockImplementation(real.fstatSync);
  vi.mocked(fs.lstatSync).mockImplementation(real.lstatSync as typeof fs.lstatSync);
  vi.mocked(fs.openSync).mockImplementation(real.openSync);
  vi.mocked(fs.readSync).mockImplementation(real.readSync as typeof fs.readSync);
  vi.mocked(fs.readdirSync).mockImplementation(real.readdirSync as typeof fs.readdirSync);
  vi.mocked(fs.realpathSync).mockImplementation(real.realpathSync as typeof fs.realpathSync);
};

function worktree(): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-collect-")));
  dirs.push(root);
  const dir = join(root, ARTIFACT_COLLECTION_DIR);
  mkdirSync(dir, { recursive: true });
  reset();
  return { root, dir };
}

describe("collectArtifactFiles on a worktree that changes or cannot be read", () => {
  it("collects nothing for a worktree that no longer exists", () => {
    reset();
    expect(collectArtifactFiles(join(tmpdir(), `mimir-missing-${newId("op")}`))).toEqual({
      files: [],
      skipped: [],
      truncated: null,
    });
  });

  it("reports a .mimir that is a file instead of a directory, without reading it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-collect-")));
    dirs.push(root);
    reset();
    writeFileSync(join(root, ".mimir"), "not a directory");
    expect(collectArtifactFiles(root).skipped).toEqual([{ name: ".mimir", reason: "not_a_file" }]);
  });

  it("refuses an artifacts directory that resolves outside the worktree", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "notes.txt"), "x");
    // e.g. a parent directory swapped for a symlink after its lstat
    vi.mocked(fs.realpathSync).mockImplementation(((p: fs.PathLike) =>
      String(p) === dir ? "/etc" : real.realpathSync(p)) as typeof fs.realpathSync);
    expect(collectArtifactFiles(root)).toEqual({
      files: [],
      skipped: [{ name: ARTIFACT_COLLECTION_DIR, reason: "outside_worktree" }],
      truncated: null,
    });
  });

  it("collects nothing when the artifacts directory disappears before it is resolved", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "notes.txt"), "x");
    vi.mocked(fs.realpathSync).mockImplementation(((p: fs.PathLike) => {
      if (String(p) === dir) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return real.realpathSync(p);
    }) as typeof fs.realpathSync);
    expect(collectArtifactFiles(root)).toEqual({ files: [], skipped: [], truncated: null });
  });

  it("reports an artifacts directory that cannot be listed", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "notes.txt"), "x");
    vi.mocked(fs.readdirSync).mockImplementation((() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }) as unknown as typeof fs.readdirSync);
    expect(collectArtifactFiles(root)).toEqual({
      files: [],
      skipped: [{ name: ARTIFACT_COLLECTION_DIR, reason: "unreadable" }],
      truncated: null,
    });
  });

  it("skips an entry removed between listing and lstat, and keeps the others", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    vi.mocked(fs.lstatSync).mockImplementation(((p: fs.PathLike) => {
      if (String(p) === join(dir, "a.txt"))
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return real.lstatSync(p);
    }) as typeof fs.lstatSync);
    const result = collectArtifactFiles(root);
    expect(result.skipped).toEqual([{ name: "a.txt", reason: "unreadable" }]);
    expect(result.files.map((f) => [f.name, f.content.toString()])).toEqual([["b.txt", "b"]]);
  });

  it("skips a file it may not open, and one swapped for a symlink after lstat", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags: number) => {
      if (String(p) === join(dir, "a.txt"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (String(p) === join(dir, "b.txt"))
        throw Object.assign(new Error("loop"), { code: "ELOOP" });
      return real.openSync(p, flags);
    }) as typeof fs.openSync);
    expect(collectArtifactFiles(root).skipped).toEqual([
      { name: "a.txt", reason: "unreadable" },
      { name: "b.txt", reason: "symlink" },
    ]);
  });

  it("refuses a file replaced by another between lstat and open", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "a.txt"), "a");
    vi.mocked(fs.fstatSync).mockImplementation(((fd: number) => {
      const st = real.fstatSync(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as fs.Stats, st, {
        ino: st.ino + 1,
      });
    }) as typeof fs.fstatSync);
    const result = collectArtifactFiles(root);
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([{ name: "a.txt", reason: "not_a_file" }]);
  });

  it("records what is there when a file shrinks while it is read", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "a.txt"), "abcdef");
    let calls = 0;
    vi.mocked(fs.readSync).mockImplementation(((fd: number, buf: Buffer) => {
      calls += 1;
      if (calls > 1) return 0; // end of file: the agent truncated it
      return real.readSync(fd, buf, 0, 3, 0);
    }) as typeof fs.readSync);
    expect(collectArtifactFiles(root).files.map((f) => f.content.toString())).toEqual(["abc"]);
  });

  it("skips a file whose read fails", () => {
    const { root, dir } = worktree();
    writeFileSync(join(dir, "a.txt"), "abc");
    vi.mocked(fs.readSync).mockImplementation((() => {
      throw Object.assign(new Error("io"), { code: "EIO" });
    }) as unknown as typeof fs.readSync);
    expect(collectArtifactFiles(root).skipped).toEqual([{ name: "a.txt", reason: "unreadable" }]);
  });

  it("skips a file that grew past the limit after lstat, reading no more than the limit", () => {
    const { root, dir } = worktree();
    const limits = { ...DEFAULT_COLLECT_LIMITS, maxFileBytes: 4 };
    writeFileSync(join(dir, "a.txt"), "0123456789");
    vi.mocked(fs.lstatSync).mockImplementation(((p: fs.PathLike) => {
      const st = real.lstatSync(p);
      if (String(p) !== join(dir, "a.txt")) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as fs.Stats, st, {
        size: 2, // what it was when listed
      });
    }) as typeof fs.lstatSync);
    expect(collectArtifactFiles(root, limits)).toEqual({
      files: [],
      skipped: [{ name: "a.txt", reason: "file_too_large", bytes: 5, limitBytes: 4 }],
      truncated: null,
    });
  });
});

describe("recordCollection of non-text content", () => {
  it("stores bytes that are not UTF-8 as they are, even outside screenshots", () => {
    const { root, dir } = worktree();
    const blob = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    writeFileSync(join(dir, "dump.bin"), blob);
    const store = new ArtifactStore(join(root, "store"));
    const emitted: CollectedEmit[] = [];
    recordCollection(collectArtifactFiles(root), {
      task: { id: newId("tsk"), missionId: newId("msn") },
      write: (content) => store.write(content),
      emit: (e) => emitted.push(e),
    });
    const [recorded] = emitted;
    expect(recorded).toMatchObject({
      type: "artifact.recorded",
      payload: { kind: "file", name: "dump.bin", bytes: 4 },
    });
    expect(store.read((recorded!.payload as { artifactId: string }).artifactId)).toEqual(blob);
  });
});
