import { mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRun } from "./index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "brokkr-run-intact-"));
/** Every run gets its own home: these tests vandalise the run store. */
const fresh = () => createRun(tmp(), { home: tmp() });

describe("RunHandle.assertIntact (B3b fix round 3, run-root acceptance)", () => {
  it("passes for an untouched run directory", async () => {
    const run = await fresh();
    await expect(run.assertIntact()).resolves.toBeUndefined();
  });

  it("refuses a run directory that was removed", async () => {
    const run = await fresh();
    rmSync(run.dir, { recursive: true });
    await expect(run.assertIntact()).rejects.toMatchObject({ code: "infra" });
  });

  it("refuses a run directory replaced by a symlink", async () => {
    const run = await fresh();
    renameSync(run.dir, `${run.dir}.moved`);
    symlinkSync(tmp(), run.dir);
    await expect(run.assertIntact()).rejects.toMatchObject({ code: "infra" });
  });

  it("refuses when an ancestor (.brokkr) was replaced by a symlink", async () => {
    const run = await fresh();
    // <home>/.brokkr/runs/<workspace hash>/run_<id>
    const dotBrokkr = dirname(dirname(dirname(run.dir)));
    expect(dotBrokkr.endsWith(".brokkr")).toBe(true);
    renameSync(dotBrokkr, `${dotBrokkr}.moved`);
    symlinkSync(`${dotBrokkr}.moved`, dotBrokkr);
    await expect(run.assertIntact()).rejects.toMatchObject({ code: "infra" });
  });
});
