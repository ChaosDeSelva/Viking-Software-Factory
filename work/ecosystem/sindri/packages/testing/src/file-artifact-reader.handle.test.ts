import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/** What the next opened handle should pretend, so the checks made through the handle can fail. */
const state = vi.hoisted(() => ({
  mode: "real" as "real" | "not-a-file" | "never-reads",
  closed: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return {
        stat: async () => {
          const info = await handle.stat();
          return state.mode === "not-a-file" ? { isFile: () => false, size: info.size } : info;
        },
        readFile: (options: { encoding: "utf8" }) =>
          state.mode === "never-reads" ? new Promise<string>(() => {}) : handle.readFile(options),
        close: async () => {
          state.closed += 1;
          await handle.close();
        },
      } as unknown as FileHandle;
    },
  };
});

const { testFileArtifactContentReader } = await import("./file-artifact-reader.js");

const dirs: string[] = [];
afterEach(() => {
  state.mode = "real";
  state.closed = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "s6-art-"));
  dirs.push(root);
  writeFileSync(join(root, "report.json"), "content");
  return { root, artifact: { id: "art_1", uri: pathToFileURL(join(root, "report.json")).href } };
}

describe("testFileArtifactContentReader: checks through the open handle", () => {
  it("reads through the handle and closes it", async () => {
    const { root, artifact } = fixture();
    const reader = testFileArtifactContentReader({ roots: [root] });
    await expect(reader.read(artifact)).resolves.toBe("content");
    expect(state.closed).toBe(1);
  });

  it("refuses a path that stopped being a regular file between the check and the open", async () => {
    const { root, artifact } = fixture();
    state.mode = "not-a-file";
    const reader = testFileArtifactContentReader({ roots: [root] });
    await expect(reader.read(artifact)).rejects.toThrow("artifact art_1 is not a regular file");
    expect(state.closed).toBe(1);
  });

  it("gives up on a read that never finishes, and still closes the handle", async () => {
    const { root, artifact } = fixture();
    state.mode = "never-reads";
    const reader = testFileArtifactContentReader({ roots: [root], timeoutMs: 1 });
    await expect(reader.read(artifact)).rejects.toThrow("artifact art_1 read timed out");
    expect(state.closed).toBe(1);
  });
});
