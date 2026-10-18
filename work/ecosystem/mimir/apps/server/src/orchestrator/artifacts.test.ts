import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifacts.js";

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mimir-art-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ArtifactStore", () => {
  it("stores content under <dir>/<id> with sha256 and size, mode 0600", () => {
    const dir = join(tmp(), "artifacts");
    const store = new ArtifactStore(dir);
    const a = store.write("hello");
    expect(a.id).toMatch(/^art_/);
    expect(a.path).toBe(join(dir, a.id));
    expect(a.bytes).toBe(5);
    expect(a.hash).toBe(`sha256:${createHash("sha256").update("hello").digest("hex")}`);
    expect(a.uri).toBe(`file://${join(dir, a.id)}`);
    expect(readFileSync(a.path, "utf8")).toBe("hello");
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    expect(store.read(a.id)?.toString("utf8")).toBe("hello");
  });

  it("read returns null for unknown or malformed ids (no traversal)", () => {
    const store = new ArtifactStore(tmp());
    expect(store.read("art_01J00000000000000000000000")).toBeNull();
    expect(store.read("../etc/passwd")).toBeNull();
  });

  it("prunes files older than the retention window", () => {
    const store = new ArtifactStore(tmp());
    const old = store.write("old");
    const fresh = store.write("fresh");
    const now = new Date("2026-06-01T00:00:00Z");
    const longAgo = new Date(now.getTime() - 31 * 86_400_000);
    utimesSync(old.path, longAgo, longAgo);
    utimesSync(fresh.path, now, now);
    expect(store.prune(now, 30)).toEqual([old.id]);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
  });
});
