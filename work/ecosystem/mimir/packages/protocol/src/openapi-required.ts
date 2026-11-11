// Internal to generateOpenApi (not re-exported from the package index).
import { zodToOpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/** Every object schema reachable from `roots` (through arrays, unions, records, wrappers, lazies). */
function objectsIn(roots: readonly (z.ZodType | undefined)[]): Set<z.ZodObject> {
  const out = new Set<z.ZodObject>();
  const seen = new Set<unknown>();
  const visit = (schema: unknown): void => {
    if (!(schema instanceof z.ZodType) || seen.has(schema)) return;
    seen.add(schema);
    if (schema instanceof z.ZodObject) out.add(schema);
    if (schema instanceof z.ZodLazy) {
      // The generator calls the getter again; a fresh object each time could not be matched.
      const inner = schema._zod.def.getter();
      if (inner !== schema._zod.def.getter())
        throw new Error("z.lazy getter must return the same schema on every call");
      visit(inner);
    }
    for (const v of Object.values(schema._zod.def as unknown as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v instanceof z.ZodType) visit(v);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(visit);
    }
  };
  roots.forEach(visit);
  return out;
}

/**
 * Runs `generate` with every object that has `exactOptional()` fields carrying its true `required`
 * list. zod-to-openapi marks a field required when `safeParse(undefined)` fails, which an
 * `exactOptional()` field does although its key may be absent, and it offers no per-field override:
 * the only hook is object-level metadata. That is set here by schema identity in the generator's own
 * registry and removed afterwards, so a schema with metadata of its own fails loudly.
 */
export function withExactOptionalKeys<T>(
  roots: readonly (z.ZodType | undefined)[],
  generate: () => T,
): T {
  const added: z.ZodObject[] = [];
  try {
    for (const obj of objectsIn(roots)) {
      const shape = obj.shape as Record<string, z.ZodType>;
      const keys = Object.keys(shape);
      const absent = keys.filter(
        (k) => shape[k]!._zod.optin === "optional" && !shape[k]!.safeParse(undefined).success,
      );
      if (absent.length === 0) continue;
      if (zodToOpenAPIRegistry.has(obj))
        throw new Error(`object with fields ${keys.join(", ")} already has OpenAPI metadata`);
      // An empty list, not none: absent metadata keeps the generator's own (wrong) list.
      const required = keys.filter(
        (k) => !absent.includes(k) && !shape[k]!.safeParse(undefined).success,
      );
      zodToOpenAPIRegistry.add(obj, { required });
      added.push(obj);
    }
    return generate();
  } finally {
    for (const obj of added) zodToOpenAPIRegistry.remove(obj);
  }
}
