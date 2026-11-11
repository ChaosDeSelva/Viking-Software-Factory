import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** File hashes held open by the test, so it controls when each read completes. */
const gates: Array<() => void> = [];
let lstatCalls = 0;

vi.mock("@brokkr/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@brokkr/core")>();
  return {
    ...core,
    fileDigest: async (file: string) => {
      await new Promise<void>((release) => gates.push(release));
      return core.fileDigest(file);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: (...args: Parameters<typeof fs.lstat>) => {
      lstatCalls++;
      return fs.lstat(...args);
    },
  };
});

const { workspaceTreeDigest } = await import("./index.js");

async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000 && !until(); i++) await new Promise((r) => setImmediate(r));
}

describe("workspaceTreeDigest window", () => {
  it("walks no further ahead than the hashing window, and the digest is unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brokkr-evidence-window-"));
    const sha = (data: string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const expected: string[] = [];
    for (let i = 0; i < 100; i++) {
      const name = `f${String(i).padStart(3, "0")}`;
      writeFileSync(join(dir, name), name);
      expected.push(`F\0${name}\0-\0${sha(name)}\n`);
    }
    const digest = workspaceTreeDigest(dir);
    await settle(() => gates.length >= 16);
    // Every read in the window is held, so the walk must be paused instead of listing all 100 files.
    await settle(() => false);
    expect(gates.length).toBe(16);
    expect(lstatCalls).toBeLessThanOrEqual(17);
    // Release the reads newest first: results are still hashed in walk order.
    let done = false;
    const result = digest.finally(() => (done = true));
    while (!done) {
      while (gates.length > 0) gates.pop()!();
      await new Promise((r) => setImmediate(r));
    }
    expect(await result).toBe(sha(expected.join("")));
  });
});
