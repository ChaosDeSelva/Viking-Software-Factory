import { readFileSync } from "node:fs";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EVENT_TYPES } from "./events.js";
import {
  OPENAPI_COMPONENTS,
  generateEventEnvelopeJsonSchema,
  generateOpenApi,
  jsonSchemaOf,
} from "./openapi.js";
import { PROTOCOL_PACKAGE_VERSION } from "./version.js";
import { ListEventsQuerySchema, RequestPrResponseSchema } from "./commands.js";

const ENDPOINTS = [
  "GET /v1/health",
  "GET /v1/capabilities",
  "GET /v1/snapshot",
  "POST /v1/projects",
  "GET /v1/projects",
  "POST /v1/missions",
  "GET /v1/missions",
  "GET /v1/missions/:id",
  "POST /v1/missions/:id/start",
  "POST /v1/missions/:id/cancel",
  "POST /v1/crews",
  "GET /v1/crews",
  "POST /v1/crews/:id/pause",
  "POST /v1/crews/:id/resume",
  "PATCH /v1/crews/:id/budget",
  "PATCH /v1/missions/:id/budget",
  "POST /v1/tasks/:id/verify",
  "GET /v1/tasks/:id",
  "GET /v1/sessions/:id",
  "GET /v1/tasks",
  "POST /v1/tasks",
  "POST /v1/tasks/:id/retry",
  "POST /v1/tasks/:id/pr",
  "GET /v1/approvals",
  "POST /v1/approvals/:id/decision",
  "POST /v1/sessions/:id/input",
  "POST /v1/sessions/:id/stop",
  "GET /v1/events",
  "GET /v1/events/stream",
  "GET /v1/artifacts/:id",
  "GET /v1/artifacts/:id/content",
  "GET /v1/usage",
];

type Doc = ReturnType<typeof generateOpenApi>;
const toOpenApiPath = (p: string) => p.replace(/:(\w+)/g, "{$1}");
const operation = (doc: Doc, endpoint: string) => {
  const [method, path] = endpoint.split(" ") as [string, string];
  const item = doc.paths?.[toOpenApiPath(path)] as Record<string, unknown> | undefined;
  return item?.[method.toLowerCase()] as
    | { parameters?: { in: string; name: string; required?: boolean }[]; responses: object }
    | undefined;
};

describe("generateOpenApi", () => {
  const doc = generateOpenApi();

  it("produces a valid OpenAPI 3.1 document", async () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    const result = await new Validator().validate(
      structuredClone(doc) as unknown as Parameters<Validator["validate"]>[0],
    );
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(ENDPOINTS)("documents %s", (endpoint) => {
    expect(operation(doc, endpoint)).toBeDefined();
  });

  it("documents exactly the listed endpoints", () => {
    const listed = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item as object).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(listed.sort()).toEqual(ENDPOINTS.map(toOpenApiPath).sort());
  });

  it("requires the idempotency-key header on every mutation (the server refuses one without it)", () => {
    const mutations = ENDPOINTS.filter((e) => !e.startsWith("GET "));
    expect(mutations).toContain("PATCH /v1/crews/:id/budget");
    for (const endpoint of mutations) {
      const header = operation(doc, endpoint)?.parameters?.find(
        (p) => p.in === "header" && p.name === "idempotency-key",
      );
      expect(header?.required, endpoint).toBe(true);
    }
  });

  it("emits shared schemas as components", () => {
    expect(Object.keys(doc.components?.schemas ?? {}).sort()).toEqual(
      Object.keys(OPENAPI_COMPONENTS).sort(),
    );
  });

  it("never lists as required a field the schema lets a response leave out", () => {
    const schemas = doc.components?.schemas as Record<string, { required?: string[] }>;
    for (const [name, schema] of Object.entries(OPENAPI_COMPONENTS)) {
      if (!(schema instanceof z.ZodObject)) continue;
      const shape = schema.shape as Record<string, z.ZodType>;
      const absent = Object.keys(shape).filter(
        (k) => z.object({ [k]: shape[k]! }).safeParse({}).success,
      );
      for (const k of absent) expect(schemas[name]?.required ?? [], name).not.toContain(k);
    }
    // A usage sample without prompt-cache reads (an `unavailable` one) is valid.
    expect(schemas.UsageSample?.required).not.toContain("cachedTokens");
    expect(schemas.UsageSample?.required).toContain("tokens");
  });

  it("does not require the optional runtime handles of a task's sessions", () => {
    const res = operation(doc, "GET /v1/tasks/:id")?.responses as Record<
      string,
      { content: { "application/json": { schema: unknown } } }
    >;
    const session = (
      res["200"]!.content["application/json"].schema as {
        properties: {
          sessions: {
            items: { required: string[]; properties: Record<string, { required?: string[] }> };
          };
        };
      }
    ).properties.sessions.items;
    expect(session.properties.runtimeRef?.required).toEqual([]);
    expect(Object.keys(session.properties.runtimeRef ?? {})).toContain("properties");
    expect(session.required).toContain("runtimeRef");
  });

  it("marks request bodies optional only when every field is optional", () => {
    const body = (e: string) =>
      (operation(doc, e) as { requestBody?: { required?: boolean } } | undefined)?.requestBody;
    for (const e of [
      "POST /v1/missions/:id/start",
      "POST /v1/missions/:id/cancel",
      "POST /v1/tasks/:id/retry",
      "POST /v1/tasks/:id/pr",
    ]) {
      expect(body(e)?.required, e).toBe(false);
    }
    for (const e of [
      "POST /v1/missions",
      "POST /v1/sessions/:id/stop",
      "POST /v1/approvals/:id/decision",
    ]) {
      expect(body(e)?.required, e).toBe(true);
    }
  });

  it("matches the committed openapi.json", () => {
    const committed = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});

describe("generateEventEnvelopeJsonSchema", () => {
  const schema = generateEventEnvelopeJsonSchema() as {
    $schema: string;
    type: string;
    required: string[];
    properties: Record<string, { const?: unknown; enum?: unknown[] }>;
  };

  it("describes the envelope", () => {
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "id",
        "schemaVersion",
        "streamId",
        "sequence",
        "occurredAt",
        "observedAt",
        "type",
        "source",
        "provenance",
      ]),
    );
    expect(schema.properties.schemaVersion?.const).toBe(1);
    expect(schema.properties.type?.enum).toEqual([...EVENT_TYPES]);
  });

  it("matches the committed schemas/event-envelope.json", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../schemas/event-envelope.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(schema);
  });
});

describe("versioning (T12b)", () => {
  it("info.version is the protocol package version, which is 0.4.0", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe("0.4.0");
    expect(PROTOCOL_PACKAGE_VERSION).toBe(pkg.version);
    expect(generateOpenApi().info.version).toBe(pkg.version);
  });

  it("documents the POST /v1/tasks/{id}/pr 202 response with status and approvalId", () => {
    const doc = generateOpenApi();
    const text = JSON.stringify(doc.paths?.["/v1/tasks/{id}/pr"]);
    expect(text).toContain('"202"');
    expect(text).toContain("approval_required");
    expect(text).toContain("approvalId");
    expect(text).toContain("prUrl");
  });
});

describe("jsonSchemaOf (T12b, SDK contract fixtures)", () => {
  it("converts a protocol schema to JSON Schema for input or output", () => {
    const out = jsonSchemaOf(RequestPrResponseSchema, "output") as {
      oneOf?: unknown[];
      anyOf?: unknown[];
    };
    expect(JSON.stringify(out)).toContain("approval_required");
    expect(JSON.stringify(jsonSchemaOf(ListEventsQuerySchema, "input"))).toContain("cursor");
  });
});
