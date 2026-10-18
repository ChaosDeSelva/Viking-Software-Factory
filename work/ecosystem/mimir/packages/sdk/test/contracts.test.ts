/**
 * The SDK tarball ships `contracts/`: one JSON fixture per OpenAPI operation (request and response
 * examples plus their JSON Schemas, both from the @mimir/protocol schemas) so consumers can run
 * contract tests offline. Regenerate with `UPDATE_CONTRACTS=1 pnpm --filter @mimir/sdk test`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiErrorBodySchema, generateOpenApi } from "@mimir/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_SCHEMAS, generateContracts, type ContractFixture } from "./contracts.js";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts");
let generated: Map<string, unknown>;

beforeAll(async () => {
  generated = await generateContracts();
  if (process.env["UPDATE_CONTRACTS"] === "1") {
    rmSync(contractsDir, { recursive: true, force: true });
    mkdirSync(contractsDir, { recursive: true });
    for (const [file, value] of generated) {
      writeFileSync(join(contractsDir, file), `${JSON.stringify(value, null, 2)}\n`);
    }
  }
}, 60_000);

const fixtures = () =>
  [...generated.entries()].filter(([f]) => f !== "index.json" && f !== "errors.json") as [
    string,
    ContractFixture,
  ][];

describe("contract fixtures", () => {
  it("has one fixture per OpenAPI operation, listed in index.json", () => {
    const doc = generateOpenApi() as unknown as { paths: Record<string, Record<string, unknown>> };
    const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(
      fixtures()
        .map(([, f]) => f.operation)
        .sort(),
    ).toEqual([...operations].sort());
    const index = generated.get("index.json") as {
      operations: { operation: string; file: string }[];
    };
    expect(index.operations.map((o) => o.operation).sort()).toEqual([...operations].sort());
    for (const o of index.operations) expect(generated.has(o.file), o.file).toBe(true);
  });

  it("every request and response example parses with its protocol schema", () => {
    for (const [file, f] of fixtures()) {
      const schemas = CONTRACT_SCHEMAS[f.operation];
      expect(schemas, f.operation).toBeDefined();
      if (schemas!.request) {
        expect(schemas!.request.safeParse(f.request.body).success, `${file} request`).toBe(true);
      }
      if (schemas!.response) {
        expect(schemas!.response.safeParse(f.response.body).success, `${file} response`).toBe(true);
        expect(f.schemas.response, file).toBeTypeOf("object");
      }
      expect(f.response.status, file).toBe(f.status);
    }
    const errors = generated.get("errors.json") as { examples: { body: unknown }[] };
    expect(errors.examples.length).toBeGreaterThan(0);
    for (const e of errors.examples)
      expect(ApiErrorBodySchema.safeParse(e.body).success).toBe(true);
  });

  it("the PR route fixture shows the approval_required reply", () => {
    const pr = generated.get("post-v1-tasks-id-pr.json") as ContractFixture;
    expect(pr.response.body).toMatchObject({ status: "approval_required" });
  });

  it("matches the committed contracts/ directory (deterministic ids and timestamps)", () => {
    expect(existsSync(contractsDir)).toBe(true);
    const committed = new Map(
      readdirSync(contractsDir).map((f) => [
        f,
        JSON.parse(readFileSync(join(contractsDir, f), "utf8")) as unknown,
      ]),
    );
    expect([...committed.keys()].sort()).toEqual([...generated.keys()].sort());
    for (const [file, value] of generated) expect(committed.get(file), file).toEqual(value);
  });
});
