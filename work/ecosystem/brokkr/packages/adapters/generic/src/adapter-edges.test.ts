import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenericAdapter } from "./index.js";
import { makeContext } from "../test/context.js";

describe("generic adapter edges", () => {
  it("validateEnvironment reports a missing cwd and has no warnings in isolated mode", async () => {
    const { ctx } = makeContext();
    expect(await createGenericAdapter().validateEnvironment(ctx)).toEqual({
      compatible: true,
      issues: [],
      warnings: [],
    });
    const missing = join(ctx.cwd, "nope");
    expect(await createGenericAdapter().validateEnvironment({ ...ctx, cwd: missing })).toEqual({
      compatible: false,
      issues: [`working directory ${missing} does not exist`],
      warnings: [],
    });
  });

  it("refuses a selected skill missing from the catalog", async () => {
    const { ctx, skills } = makeContext();
    await expect(
      createGenericAdapter().prepare([{ ...skills[0]!, name: "ghost" }], ctx),
    ).rejects.toThrow("skill 'ghost' is not in the skill catalog");
  });
});
