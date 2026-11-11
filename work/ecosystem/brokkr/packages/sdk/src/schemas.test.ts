import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { Brokkr } from "./index.js";
import {
  selectionJsonSchema,
  verificationEventJsonSchema,
  verificationReportJsonSchema,
} from "./schemas.js";
import { MockExecutor } from "./testing.js";
import { BUILTIN, reactRepo, tempDir } from "../test/fixtures.js";

const committed = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", name), "utf8"));

describe("published JSON Schemas", () => {
  it("carry draft 2020-12 metadata and match the committed files", () => {
    const cases = [
      ["verification-report.v1.json", verificationReportJsonSchema(), "Brokkr VerificationReport"],
      ["verification-event.v1.json", verificationEventJsonSchema(), "Brokkr verification event"],
      ["selection.v1.json", selectionJsonSchema(), "Brokkr Selection"],
    ] as const;
    for (const [file, schema, title] of cases) {
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://brokkr.local/schemas/${file}`,
        title,
      });
      expect(Object.keys(schema).slice(0, 4)).toEqual(["$schema", "$id", "title", "description"]);
      expect(schema, file).toEqual(committed(file));
    }
  });

  it("accept what resolve and verify produce and reject unknown fields", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validReport = ajv.compile(verificationReportJsonSchema());
    const validSelection = ajv.compile(selectionJsonSchema());
    const validEvent = ajv.compile(verificationEventJsonSchema());
    const cwd = reactRepo();
    const brokkr = new Brokkr({
      cwd,
      builtinDir: BUILTIN,
      homeDir: tempDir("brokkr-home-"),
      executor: new MockExecutor({ test: "passed" }),
    });
    const selection = await brokkr.resolve({
      task: { id: "QA-5", title: "qa", description: "qa", taskTypes: ["qa"] },
    });
    const events: unknown[] = [];
    const report = await brokkr.verify({
      selection,
      workspace: cwd,
      onEvent: (e) => events.push(e),
    });
    const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    expect(validSelection(plain(selection))).toBe(true);
    expect(validReport(plain(report))).toBe(true);
    for (const e of events) expect(validEvent(plain(e))).toBe(true);
    expect(validReport({ ...plain(report), plannedBy: "x" })).toBe(false);
    expect(validSelection({ ...plain(selection), plannedBy: "x" })).toBe(false);
  });
});
