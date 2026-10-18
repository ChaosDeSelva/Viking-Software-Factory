import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveHarness } from "./doctor.js";
it("resolves an executable override without interpreting shell characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-probe-"));
  try {
    const binary = join(dir, "agent; not-a-command");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect(resolveHarness("claude", { MIMIR_CLAUDE_BIN: binary })).toBe(binary);
    expect(resolveHarness("claude", { MIMIR_CLAUDE_BIN: "$(unsafe)", PATH: dir })).toBe(null);
    expect(() => resolveHarness("unknown", {})).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
