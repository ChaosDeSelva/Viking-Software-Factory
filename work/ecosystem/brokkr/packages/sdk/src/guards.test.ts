/**
 * Defence-in-depth guards of the SDK facade that the public resolver never
 * lets through on its own: they are exercised by subclassing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@brokkr/registry";
import { Brokkr, type Selection } from "./index.js";
import { BUILTIN, TASK, reactRepo, tempDir } from "../test/fixtures.js";

/** A Brokkr whose re-resolution reports every harness as not allowed to execute. */
class ExecutionRevoked extends Brokkr {
  protected override async materialize(raw: Selection, registry: Registry, options = {}) {
    const out = await super.materialize(raw, registry, options);
    return {
      ...out,
      set: {
        ...out.set,
        harnesses: out.set.harnesses.map((h) => ({ ...h, executionAllowed: false })),
      },
    };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Brokkr.prepare trust guard", () => {
  it("refuses harnesses that are not allowed to execute even when the selection verifies", async () => {
    const cwd = reactRepo();
    const options = { cwd, builtinDir: BUILTIN, homeDir: tempDir("brokkr-home-") };
    const selection = await new Brokkr(options).resolve({ task: TASK, profile: "frontend-strict" });
    await expect(
      new ExecutionRevoked(options).prepare({ selection, provider: "claude-code" }),
    ).rejects.toMatchObject({
      code: "trust_required",
      message: expect.stringMatching(/refusing to prepare instructions from untrusted sources: /),
    });
    expect(existsSync(join(cwd, ".brokkr", "generated"))).toBe(false);
  });
});

describe("default logger", () => {
  it("discards every level without writing to the console", () => {
    class Probe extends Brokkr {
      logAll(): unknown[] {
        return [
          this.logger.debug({ a: 1 }, "d"),
          this.logger.info({ a: 1 }, "i"),
          this.logger.warn({ a: 1 }, "w"),
          this.logger.error({ a: 1 }, "e"),
        ];
      }
    }
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    expect(new Probe({ cwd: tempDir(), builtinDir: BUILTIN }).logAll()).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
