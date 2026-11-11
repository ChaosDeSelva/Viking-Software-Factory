import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  zodToOpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withExactOptionalKeys } from "./openapi-required.js";

type Obj = { properties: Record<string, Obj>; required?: string[]; items?: Obj };

function generate(root: z.ZodType) {
  const registry = new OpenAPIRegistry();
  registry.registerPath({
    method: "get",
    path: "/x",
    responses: { 200: { description: "OK", content: { "application/json": { schema: root } } } },
  });
  const doc = withExactOptionalKeys([root], () =>
    new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
    }),
  );
  return (
    doc.paths!["/x"]!.get!.responses!["200"] as {
      content: { "application/json": { schema: Obj } };
    }
  ).content["application/json"].schema;
}

describe("withExactOptionalKeys", () => {
  it("leaves exactOptional fields out of required, wherever the object is nested", () => {
    const inner = z.object({ a: z.string(), b: z.number().exactOptional() });
    const later = z.object({ c: z.string().exactOptional(), d: z.string() });
    const root = z.object({
      list: z.array(inner),
      lazy: z.lazy(() => later),
      plain: z.string().optional(),
    });
    const out = generate(root);
    expect(out.properties.list!.items!.required).toEqual(["a"]);
    expect(out.properties.lazy!.required).toEqual(["d"]);
    expect(out.required).toEqual(["list", "lazy"]);
  });

  it("matches by schema identity: same field names may differ in what is required", () => {
    // A field-name match could not tell these apart.
    const loose = z.object({ x: z.string().exactOptional(), y: z.string() });
    const strict = z.object({ x: z.string(), y: z.string() });
    const out = generate(z.object({ loose, strict }));
    expect(out.properties.loose!.required).toEqual(["y"]);
    expect(out.properties.strict!.required).toEqual(["x", "y"]);
  });

  it("refuses a lazy schema that builds a new object on each call", () => {
    const root = z.object({ lazy: z.lazy(() => z.object({ c: z.string().exactOptional() })) });
    expect(() => withExactOptionalKeys([root], () => 1)).toThrow(/same schema on every call/);
  });

  it("restores the generator's registry, even when generation throws", () => {
    const obj = z.object({ x: z.string().exactOptional() });
    expect(() =>
      withExactOptionalKeys([obj], () => {
        expect(zodToOpenAPIRegistry.get(obj)).toEqual({ required: [] });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(zodToOpenAPIRegistry.has(obj)).toBe(false);
  });

  it("refuses an object that already carries generator metadata", () => {
    const obj = z.object({ x: z.string().exactOptional() });
    zodToOpenAPIRegistry.add(obj, { description: "own" });
    try {
      expect(() => withExactOptionalKeys([obj], () => 1)).toThrow(/already has OpenAPI metadata/);
    } finally {
      zodToOpenAPIRegistry.remove(obj);
    }
  });
});
