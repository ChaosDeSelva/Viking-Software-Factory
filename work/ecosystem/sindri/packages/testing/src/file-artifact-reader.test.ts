import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testFileArtifactContentReader } from "./file-artifact-reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const artifact = (uri: string) => ({ id: "art_1", uri });

describe("testFileArtifactContentReader (tests only; production reads through Mimir)", () => {
  it("reads file:// artifacts under an allowed root only", async () => {
    const root = mkdtempSync(join(tmpdir(), "s6-art-"));
    const outside = mkdtempSync(join(tmpdir(), "s6-out-"));
    dirs.push(root, outside);
    mkdirSync(join(root, "runs"));
    writeFileSync(join(root, "runs", "report.json"), '{"ok":true}');
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    const reader = testFileArtifactContentReader({ roots: [root] });
    await expect(
      reader.read(artifact(pathToFileURL(join(root, "runs", "report.json")).href)),
    ).resolves.toBe('{"ok":true}');
    await expect(
      reader.read(artifact(pathToFileURL(join(outside, "secret.txt")).href)),
    ).rejects.toThrow(/outside the allowed artifact roots/);
    await expect(reader.read(artifact(pathToFileURL(join(root, "link.txt")).href))).rejects.toThrow(
      /outside the allowed artifact roots/,
    );
    await expect(reader.read(artifact("https://example.com/x"))).rejects.toThrow(/only file:/);
  });

  it("refuses artifacts larger than the limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "s6-art-"));
    dirs.push(root);
    writeFileSync(join(root, "big.txt"), "x".repeat(2048));
    const reader = testFileArtifactContentReader({ roots: [root], maxBytes: 1024 });
    await expect(reader.read(artifact(pathToFileURL(join(root, "big.txt")).href))).rejects.toThrow(
      /too large/,
    );
  });

  it("refuses a FIFO without blocking on open (audit L9)", { timeout: 3000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "s6-art-"));
    dirs.push(root);
    const fifo = join(root, "report.json");
    execFileSync("mkfifo", [fifo]);
    const reader = testFileArtifactContentReader({ roots: [root] });
    const read = reader.read(artifact(pathToFileURL(fifo).href));
    const settled = await Promise.race([
      read.then(
        () => "resolved",
        (e: Error) => e.message,
      ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    if (settled === "hung") {
      // Release the blocked open so the worker can exit, then fail.
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        /* no reader */
      }
    }
    expect(settled).toMatch(/not a regular file/);
  });
});
