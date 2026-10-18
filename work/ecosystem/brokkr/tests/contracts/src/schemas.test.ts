/**
 * Report and event schema compatibility (spec §18.3: "changes to public report
 * schemas must be checked for compatibility").
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  Brokkr,
  SelectionSchema,
  VerificationEventSchema,
  VerificationReportSchema,
  selectionJsonSchema,
  verificationEventJsonSchema,
  verificationReportJsonSchema,
  type VerificationEvent,
} from "@brokkr/sdk";
import { MockExecutor } from "@brokkr/sdk/testing";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const sdkDir = dirname(createRequire(import.meta.url).resolve("@brokkr/sdk/package.json"));
const published = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(sdkDir, "schemas", name), "utf8")) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validator = (schema: Record<string, unknown>) => {
  const validate = ajv.compile(schema);
  return (value: unknown): string[] =>
    validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};
const validateReport = validator(published("verification-report.v1.json"));
const validateEvent = validator(published("verification-event.v1.json"));
const validateSelection = validator(published("selection.v1.json"));

describe("published JSON Schemas", () => {
  it("are up to date with the runtime schemas (regenerate with `pnpm --filter @brokkr/sdk schemas`)", () => {
    expect(published("verification-report.v1.json")).toEqual(verificationReportJsonSchema());
    expect(published("verification-event.v1.json")).toEqual(verificationEventJsonSchema());
    expect(published("selection.v1.json")).toEqual(selectionJsonSchema());
  });
});

describe("stored v1 artifacts stay readable", () => {
  it("a stored v1 report parses and validates", () => {
    const report = fixture("report.v1.json");
    expect(VerificationReportSchema.safeParse(report).success).toBe(true);
    expect(validateReport(report)).toEqual([]);
  });

  it("a stored v1 event stream parses and validates", () => {
    const events = fixture("events.v1.json") as unknown[];
    expect(events.length).toBeGreaterThan(2);
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) {
      expect(VerificationEventSchema.safeParse(e).success).toBe(true);
      expect(validateEvent(e)).toEqual([]);
    }
  });

  it("a stored v1 selection parses and validates", () => {
    const selection = fixture("selection.v1.json");
    expect(SelectionSchema.safeParse(selection).success).toBe(true);
    expect(validateSelection(selection)).toEqual([]);
  });

  it("published schemas are strict like verify (review I5): unknown fields are rejected", async () => {
    const report = structuredClone(fixture("report.v1.json")) as Record<string, unknown>;
    report.futureField = { anything: true };
    expect(validateReport(report)).not.toEqual([]);
    const selection = {
      ...(fixture("selection.v1.json") as Record<string, unknown>),
      plannedBy: "sindri",
    };
    expect(validateSelection(selection)).not.toEqual([]);
    const cwd = mkdtempSync(join(tmpdir(), "brokkr-contract-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const brokkr = new Brokkr({ cwd, homeDir: mkdtempSync(join(tmpdir(), "brokkr-home-")) });
    await expect(
      brokkr.verify({ selection: selection as never, workspace: cwd }),
    ).rejects.toMatchObject({ code: "invalid-config" });
  });

  it("published schemas still reject reports that break v1", () => {
    const report = structuredClone(fixture("report.v1.json")) as Record<string, unknown>;
    report.verdict = "mostly-passed";
    expect(validateReport(report)).not.toEqual([]);
    delete report.verdict;
    expect(validateReport(report)).not.toEqual([]);
  });
});

describe("live output matches the published schemas", () => {
  it("a verification run produces a valid report and valid events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brokkr-contract-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const brokkr = new Brokkr({
      cwd,
      homeDir: mkdtempSync(join(tmpdir(), "brokkr-home-")),
      executor: new MockExecutor({ test: "passed" }),
    });
    const selection = await brokkr.resolve({
      task: { id: "QA-1", title: "Regression", description: "qa", taskTypes: ["qa"] },
    });
    expect(validateSelection(JSON.parse(JSON.stringify(selection)))).toEqual([]);
    const events: VerificationEvent[] = [];
    const report = await brokkr.verify({
      selection,
      workspace: cwd,
      onEvent: (e) => events.push(e),
    });
    expect(validateReport(JSON.parse(JSON.stringify(report)))).toEqual([]);
    expect(events.length).toBeGreaterThan(2);
    for (const e of events) expect(validateEvent(JSON.parse(JSON.stringify(e)))).toEqual([]);
  });
});
