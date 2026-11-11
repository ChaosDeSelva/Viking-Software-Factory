import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { INTERACTIVE_HARNESSES } from "../terminal-runtime/adapter.js";

// This machine may have the ChatGPT-bundled Codex installed: whether it "exists" is controlled
// here so no real agent CLI is ever probed.
const BUNDLED =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const fs = vi.hoisted(() => ({ bundled: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: (path: string) => (path === BUNDLED ? fs.bundled : real.existsSync(path)),
    accessSync: (path: string, mode?: number) => {
      if (path === BUNDLED && fs.bundled) return;
      real.accessSync(path, mode);
    },
  };
});
const { harnessInventory, resolveHarness } = await import("./doctor.js");

const roots: string[] = [];
afterEach(() => {
  fs.bundled = false;
  vi.unstubAllEnvs();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function bin(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}
const envName = (kind: string) => `MIMIR_${kind.toUpperCase().replaceAll("-", "_")}_BIN`;

it("searches PATH for each harness's own binary name and prefers the bundled Codex", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-path-"));
  roots.push(dir);
  const cursor = bin(dir, "cursor-agent", "exit 0");
  const pi = bin(dir, "pi", "exit 0");
  writeFileSync(join(dir, "acli"), "not executable", { mode: 0o600 });
  const env = { PATH: `/nonexistent::${dir}` };
  expect(resolveHarness("cursor", env)).toBe(cursor);
  expect(resolveHarness("pi-signed", env)).toBe(pi);
  expect(resolveHarness("rovo", env)).toBeNull();
  expect(resolveHarness("claude", {})).toBeNull();
  expect(resolveHarness("codex", env)).toBeNull();
  fs.bundled = true;
  expect(resolveHarness("codex", env)).toBe(BUNDLED);
  // An explicit override still wins over the bundled copy.
  expect(resolveHarness("codex", { ...env, MIMIR_CODEX_BIN: cursor })).toBe(cursor);
});

it("inventories every harness, probing versions only when asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-inventory-"));
  roots.push(dir);
  vi.stubEnv("PATH", join(dir, "empty"));
  for (const kind of INTERACTIVE_HARNESSES) vi.stubEnv(envName(kind), join(dir, "missing"));
  vi.stubEnv(envName("codex"), bin(dir, "codex", 'echo "codex-cli 0.51.0-alpha.2"'));
  vi.stubEnv(envName("claude"), bin(dir, "claude", 'echo "no version here"'));
  vi.stubEnv(envName("kimi"), bin(dir, "kimi", "exit 3"));
  vi.stubEnv(envName("cursor"), bin(dir, "cursor", 'echo "2025.10.1"'));

  const quick = await harnessInventory();
  expect(quick.map((h) => h.kind)).toEqual(INTERACTIVE_HARNESSES);
  expect(quick.filter((h) => h.installed).map((h) => h.kind)).toEqual([
    "codex",
    "claude",
    "kimi",
    "cursor",
  ]);
  expect(quick.every((h) => h.version === null)).toBe(true);

  // A generous probe limit: a loaded host can take seconds to start the stub shells.
  const byKind = Object.fromEntries((await harnessInventory(true, 60_000)).map((h) => [h.kind, h]));
  expect(byKind["codex"]).toMatchObject({
    version: "0.51.0-alpha.2",
    lifecycleObservation: "turn_end_notification",
    headless: true,
    experimental: false,
    authenticated: "not_checked",
  });
  expect(byKind["claude"]).toMatchObject({
    version: null,
    lifecycleObservation: "automatic_events",
    experimental: false,
  });
  // A failing probe means "version unknown", not "not installed".
  expect(byKind["kimi"]).toMatchObject({
    installed: true,
    version: null,
    lifecycleObservation: "acp_protocol",
    headless: false,
    experimental: true,
  });
  expect(byKind["cursor"]).toMatchObject({
    version: "2025.10.1",
    lifecycleObservation: "session_transcript",
  });
  expect(byKind["grok"]).toMatchObject({ installed: false, version: null });
  expect(byKind["rovo"]!.lifecycleObservation).toBe("automatic_events");
});
